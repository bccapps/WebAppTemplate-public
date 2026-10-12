"""
Repo Map — génère une représentation compacte d'un projet (signatures, structure).
Remplace le scan de fichiers bruts par les agents LLM.

Usage :
  python repo_map.py [project_path]              # affiche sur stdout
  python repo_map.py [project_path] --save       # écrit .repo-map.md à la racine
  python repo_map.py [project_path] --max-tokens 6000
  python repo_map.py [project_path] --stats      # affiche les métriques
  python repo_map.py [project_path] --no-index   # sans l'index compact

Deux niveaux de détail :
  ## Signatures  signatures complètes, dans la limite de --max-tokens, les
                 fichiers de l'application d'abord, puis le code partagé
                 (SHARED_DIRS), puis par date de modification décroissante.
  ## Index       tous les autres fichiers, une ligne chacun (noms déclarés
                 seulement), non plafonné : l'absence d'un fichier source de la
                 carte signifie donc qu'il n'a aucune déclaration extraite.
"""
import ast
import argparse
import hashlib
import json
import os
import re
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# ── Configuration ────────────────────────────────────────

SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", ".next", ".nuxt",
    "coverage", "__pycache__", ".venv", "venv", ".cache", ".turbo",
    "out", ".svelte-kit", "target", ".cargo", ".tox",
    # sources de tiers embarquées dans le dépôt : pas du code du projet
    "vendor", "third_party", "_deps",
}

SKIP_FILES = {
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "poetry.lock", "Pipfile.lock",
}

TS_EXTENSIONS   = {".ts", ".tsx"}
PY_EXTENSIONS   = {".py"}
DART_EXTENSIONS = {".dart"}
GO_EXTENSIONS   = {".go"}
# Dart et Go ont été ajoutés le 2026-09-17. Avant cette date la carte ne
# couvrait que TS+PY, soit ~5 % de ce dépôt (107 fichiers) — et surtout PAS
# l'app Flutter (1 827 fichiers) ni l'agent Go (321). `--check` répondait donc
# « à jour » quelles que soient les modifications du code réellement travaillé.
ALL_EXTENSIONS = TS_EXTENSIONS | PY_EXTENSIONS | DART_EXTENSIONS | GO_EXTENSIONS

# Fichiers config dont on extrait quelques infos clés
CONFIG_FILES = {"package.json", "tsconfig.json", "pyproject.toml"}

OUTPUT_FILENAME = ".repo-map.md"

# Répertoires de code partagé entre applications (sous-modules git exposés par
# lien symbolique). Leurs fichiers passent APRÈS ceux de l'application dans
# `## Signatures`. Un projet qui n'en a pas (ex. AICompanion) n'a qu'un seul
# rang : l'ordre se réduit alors à la date de modification.
SHARED_DIRS = {"modules_shared"}

INDEX_MAX_NAMES = 6  # noms listés par fichier dans l'index, au-delà « +N »


# ── File walker ──────────────────────────────────────────

def walk_project(root: Path) -> Iterator[Path]:
    """Itère sur les fichiers source en ignorant les répertoires inutiles."""
    # followlinks: les apps à sous-modules git exposent le code partagé via des
    # liens symboliques (`modules_shared/x -> ../../.libs/lib/x`) vers un
    # répertoire caché que le filtrage ci-dessous écarte par son nom. Sans suivre
    # le lien, tout le code partagé est invisible de la carte. `seen` (chemins
    # réels) évite les doublons et les cycles.
    # On ne suit que les liens dont la cible reste DANS le projet : un lien vers
    # un autre dépôt (`codesetup -> ../../Projects/CodeSetup`) en ferait entrer
    # tout le contenu dans la carte.
    root_real = os.path.realpath(root)
    seen: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        real = os.path.realpath(dirpath)
        if real != root_real and not real.startswith(root_real + os.sep):
            dirnames[:] = []
            continue
        if real in seen:
            dirnames[:] = []
            continue
        seen.add(real)
        # Prune les répertoires à ignorer in-place (évite de descendre dedans)
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS
            and not d.startswith(".")
            # `build/` était déjà écarté, mais nos répertoires CMake s'appellent
            # `build_macos`, `build_windows`, … et `_deps/` y déverse les
            # sources amont téléchargées. Sans ce préfixe, une seule
            # construction native fait entrer les tests de sentencepiece dans
            # la carte du dépôt — et la rend « périmée » à chaque build.
            and not d.startswith("build_")
            and d not in ("test", "tests", "__tests__")
            # copies de build (`back_build/`, `front_build/`) : mêmes sources, en double
            and not d.endswith("_build")
        )
        for fname in sorted(filenames):
            if fname in SKIP_FILES:
                continue
            path = Path(dirpath) / fname
            # Ignorer les fichiers de déclaration et de test
            if fname.endswith(".d.ts"):
                continue
            # `-spec.` couvre `*.e2e-spec.ts` (NestJS), `-test.`/`_test.` les
            # conventions voisines ; un répertoire `test/` ou `__tests__/` est
            # écarté entier plus haut, avec les autres répertoires non-source.
            if any(p in fname for p in [".test.", ".spec.", "-spec.", ".stories."]):
                continue
            if path.suffix in ALL_EXTENSIONS:
                yield path
            elif fname in CONFIG_FILES:
                yield path


# ── TypeScript extractor ─────────────────────────────────

# Regex pour les signatures TypeScript exportées
_TS_PATTERNS = [
    # Décorateurs NestJS / TypeORM (on les garde avec ce qui suit)
    (re.compile(r'^\s*(@\w+(?:\([^)]*\))?)\s*$'), "decorator"),
    # export class / abstract class
    (re.compile(r'^export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+[\w<>, ]+)?(?:\s+implements\s+[\w<>, ]+)?'), "class"),
    # export interface
    (re.compile(r'^export\s+(?:default\s+)?interface\s+(\w+)'), "interface"),
    # export type
    (re.compile(r'^export\s+type\s+(\w+)\s*='), "type"),
    # export enum
    (re.compile(r'^export\s+(?:const\s+)?enum\s+(\w+)'), "enum"),
    # export function / async function
    (re.compile(r'^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))'), "function"),
    # export const arrow function
    (re.compile(r'^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)'), "arrow"),
    # méthodes de classe (public / private / protected / async)
    (re.compile(r'^\s+(?:(?:public|private|protected|readonly|static|async|override)\s+)*(\w+)\s*(\([^)]*\))\s*(?::\s*[\w<>\[\]|&, .?]+)?\s*\{'), "method"),
    # propriétés de classe décorées (@Column, @Prop, etc.)
    (re.compile(r'^\s+(?:(?:public|private|protected|readonly|static)\s+)*(\w+)(?:\?|!)?\s*:\s*([\w<>\[\]|&, .?]+)'), "property"),
]

_TS_RETURN_TYPE = re.compile(r'\)\s*:\s*([\w<>\[\]|&, .?]+)\s*(?:\{|=>|$)')


def _ts_return(line: str) -> str:
    m = _TS_RETURN_TYPE.search(line)
    return f": {m.group(1).strip()}" if m else ""


def extract_typescript(path: Path) -> list[str]:
    """Extrait les signatures exportées d'un fichier TypeScript."""
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []

    results: list[str] = []
    pending_decorators: list[str] = []
    in_class = False
    brace_depth = 0

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("*"):
            continue

        # Suivi de profondeur pour savoir si on est dans une classe
        brace_depth += stripped.count("{") - stripped.count("}")

        # Décorateur
        for pat, kind in _TS_PATTERNS:
            if kind == "decorator":
                m = pat.match(stripped)
                if m:
                    pending_decorators.append(m.group(1))
                    break
        else:
            dec_prefix = " ".join(pending_decorators) + " " if pending_decorators else ""
            pending_decorators = []

            for pat, kind in _TS_PATTERNS:
                if kind == "decorator":
                    continue
                m = pat.match(stripped)
                if not m:
                    continue

                if kind == "class":
                    name = m.group(1)
                    dec = f"[{dec_prefix.strip()}] " if dec_prefix.strip() else ""
                    # Extrait extends/implements
                    extends = re.search(r'extends\s+([\w<>, ]+?)(?:\s+implements|\s*\{)', stripped)
                    implements = re.search(r'implements\s+([\w<>, ]+?)(?:\s*\{)', stripped)
                    sig = f"class {name}"
                    if extends: sig += f" extends {extends.group(1).strip()}"
                    if implements: sig += f" implements {implements.group(1).strip()}"
                    results.append(f"{dec}{sig}")
                    in_class = True
                    break

                elif kind in ("interface", "enum"):
                    results.append(f"{kind} {m.group(1)}")
                    break

                elif kind == "type":
                    results.append(f"type {m.group(1)}")
                    break

                elif kind == "function":
                    params = m.group(2) if len(m.groups()) > 1 else "()"
                    ret = _ts_return(stripped)
                    results.append(f"  fn {m.group(1)}{params}{ret}")
                    break

                elif kind == "arrow":
                    params = f"({m.group(2)})" if len(m.groups()) > 1 else "()"
                    ret = _ts_return(stripped)
                    results.append(f"  fn {m.group(1)}{params}{ret}")
                    break

                elif kind == "method" and in_class:
                    name = m.group(1)
                    if name in ("constructor", "if", "for", "while", "switch", "return"):
                        continue
                    params = m.group(2) if len(m.groups()) > 1 else "()"
                    ret = _ts_return(stripped)
                    dec = f"[{dec_prefix.strip()}] " if dec_prefix.strip() else ""
                    results.append(f"  {dec}{name}{params}{ret}")
                    break

                elif kind == "property" and in_class and dec_prefix.strip():
                    # Seulement les propriétés décorées (@Column, @Prop…)
                    name = m.group(1)
                    type_ = m.group(2) if len(m.groups()) > 1 else ""
                    results.append(f"  [{dec_prefix.strip()}] {name}: {type_}")
                    break

        if brace_depth <= 0:
            in_class = False
            brace_depth = 0

    return results


# ── Python extractor ─────────────────────────────────────

def extract_python(path: Path) -> list[str]:
    """Extrait les signatures via ast (précis, pas de regex)."""
    try:
        source = path.read_text(encoding="utf-8", errors="ignore")
        with warnings.catch_warnings():
            # les fichiers parsés ne sont pas les nôtres (sources vendorisées) :
            # leurs SyntaxWarning n'ont rien à faire sur la sortie de la carte
            warnings.simplefilter("ignore")
            tree = ast.parse(source, filename=str(path))
    except (OSError, SyntaxError):
        return []

    results: list[str] = []

    def annotation(node) -> str:
        if node is None:
            return ""
        try:
            return f": {ast.unparse(node)}"
        except Exception:
            return ""

    def params(args: ast.arguments) -> str:
        parts = []
        # positional
        n_no_default = len(args.args) - len(args.defaults)
        for i, arg in enumerate(args.args):
            ann = annotation(arg.annotation)
            if i >= n_no_default:
                default = f"={ast.unparse(args.defaults[i - n_no_default])}"
            else:
                default = ""
            parts.append(f"{arg.arg}{ann}{default}")
        if args.vararg:
            parts.append(f"*{args.vararg.arg}{annotation(args.vararg.annotation)}")
        for i, arg in enumerate(args.kwonlyargs):
            ann = annotation(arg.annotation)
            default = ""
            if args.kw_defaults[i] is not None:
                default = f"={ast.unparse(args.kw_defaults[i])}"
            parts.append(f"{arg.arg}{ann}{default}")
        if args.kwarg:
            parts.append(f"**{args.kwarg.arg}{annotation(args.kwarg.annotation)}")
        return ", ".join(parts)

    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncCoroutine if hasattr(ast, 'AsyncCoroutine') else ast.AsyncFunctionDef)):
            if node.name.startswith("_"):
                continue
            ret = annotation(node.returns)
            results.append(f"  fn {node.name}({params(node.args)}){ret}")

        elif isinstance(node, ast.AsyncFunctionDef):
            if node.name.startswith("_"):
                continue
            ret = annotation(node.returns)
            results.append(f"  async fn {node.name}({params(node.args)}){ret}")

        elif isinstance(node, ast.ClassDef):
            bases = ", ".join(ast.unparse(b) for b in node.bases) if node.bases else ""
            results.append(f"class {node.name}" + (f"({bases})" if bases else ""))
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if child.name.startswith("__") and child.name != "__init__":
                        continue
                    ret = annotation(child.returns)
                    prefix = "async " if isinstance(child, ast.AsyncFunctionDef) else ""
                    results.append(f"  {prefix}fn {child.name}({params(child.args)}){ret}")

    return results


# ── Config extractor ─────────────────────────────────────

def extract_dart(path: Path) -> list[str]:
    """Déclarations de premier niveau d'un fichier Dart, par regex.

    Volontairement peu ambitieux, et il faut savoir ce que ça n'attrape pas :
    Dart n'a pas d'`ast` dans la bibliothèque standard de Python, donc pas de
    parseur exact comme pour Python. On extrait les CLASSES, ENUMS, MIXINS,
    EXTENSIONS et TYPEDEFS de premier niveau, plus les fonctions de premier
    niveau — c'est ce qui sert à s'orienter. Les MEMBRES d'une classe ne sont
    pas extraits : sur 1 827 fichiers, ils feraient exploser le budget de
    jetons de la carte, et un nom de classe suffit à savoir quel fichier ouvrir.

    Les fichiers générés (`*.g.dart`, `*.freezed.dart`) sont écartés : ce sont
    des milliers de lignes qui n'apprennent rien à un lecteur humain ou LLM.
    """
    # Générés : des milliers de lignes qui n'apprennent rien.
    # Tests : leur seule déclaration de premier niveau est `void main()`, donc
    # ils consommeraient une entrée du budget de jetons pour dire « ce fichier
    # existe » — ce que l'arborescence dit déjà, gratuitement.
    if path.name.endswith(
        (".g.dart", ".freezed.dart", ".mocks.dart", "_test.dart")
    ):
        return []
    try:
        source = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    results: list[str] = []
    type_decl = re.compile(
        r"^(?:abstract\s+|final\s+|base\s+|interface\s+|sealed\s+|mixin\s+)*"
        r"(class|enum|mixin|extension|typedef)\s+(\w+)",
    )
    # Fonction de premier niveau : pas d'indentation, un type de retour, un nom,
    # une parenthèse. Exclut les mots-clés de contrôle qui ressemblent à un appel.
    top_fn = re.compile(
        r"^([\w<>,\s\?\[\]]+?)\s+(\w+)\s*\([^;{]*\)\s*(?:async\s*\*?\s*)?[{=]"
    )
    keywords = {"if", "for", "while", "switch", "catch", "return", "assert"}

    for line in source.splitlines():
        if line.startswith((" ", "\t")) or not line.strip():
            continue
        m = type_decl.match(line)
        if m:
            results.append(f"{m.group(1)} {m.group(2)}")
            continue
        m = top_fn.match(line)
        if m and m.group(2) not in keywords:
            results.append(f"{m.group(1).strip()} {m.group(2)}()")
    return results


def extract_go(path: Path) -> list[str]:
    """Types et fonctions/méthodes exportés d'un fichier Go, par regex.

    Seul l'EXPORTÉ est retenu (initiale majuscule) : c'est la surface qu'un
    autre paquet peut appeler, donc la seule qui aide à s'orienter. Les tests
    (`*_test.go`) sont écartés — leur surface est un détail d'implémentation.
    """
    if path.name.endswith("_test.go"):
        return []
    try:
        source = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    results: list[str] = []
    type_decl = re.compile(r"^type\s+([A-Z]\w*)\s+(\w+)")
    func_decl = re.compile(r"^func\s+(?:\(([^)]*)\)\s*)?([A-Z]\w*)\s*\(")

    for line in source.splitlines():
        m = type_decl.match(line)
        if m:
            results.append(f"type {m.group(1)} {m.group(2)}")
            continue
        m = func_decl.match(line)
        if m:
            recv = m.group(1)
            if recv:
                rtype = recv.split()[-1].lstrip("*")
                results.append(f"func ({rtype}) {m.group(2)}()")
            else:
                results.append(f"func {m.group(2)}()")
    return results


def extract_config(path: Path) -> list[str]:
    """Extrait les infos clés des fichiers de config."""
    results = []
    try:
        if path.name == "package.json":
            data = json.loads(path.read_text(encoding="utf-8"))
            if "name" in data:
                results.append(f"name: {data['name']}")
            if "version" in data:
                results.append(f"version: {data['version']}")
            if "scripts" in data:
                scripts = list(data["scripts"].keys())[:8]
                results.append(f"scripts: {', '.join(scripts)}")
            for key in ("dependencies", "devDependencies"):
                if key in data:
                    deps = list(data[key].keys())[:10]
                    results.append(f"{key}: {', '.join(deps)}")

        elif path.name == "tsconfig.json":
            data = json.loads(path.read_text(encoding="utf-8"))
            co = data.get("compilerOptions", {})
            keys = ["target", "module", "strict", "baseUrl", "paths"]
            for k in keys:
                if k in co:
                    results.append(f"{k}: {co[k]}")

        elif path.name == "pyproject.toml":
            text = path.read_text(encoding="utf-8")
            for line in text.splitlines()[:30]:
                if re.match(r'^(name|version|python)\s*=', line):
                    results.append(line.strip())

    except Exception:
        pass
    return results


# ── Directory tree ───────────────────────────────────────

def build_tree(root: Path, files: list[Path], max_depth: int = 4) -> str:
    """Construit un arbre de répertoires compact."""
    dirs: set[Path] = set()
    for f in files:
        try:
            rel = f.relative_to(root)
            for i in range(1, min(len(rel.parts), max_depth + 1)):
                dirs.add(root / Path(*rel.parts[:i]))
        except ValueError:
            pass

    lines = []
    for d in sorted(dirs):
        try:
            rel = d.relative_to(root)
            depth = len(rel.parts) - 1
            indent = "  " * depth
            lines.append(f"{indent}{rel.parts[-1]}/")
        except ValueError:
            pass

    return "\n".join(lines)


# ── Token budget ─────────────────────────────────────────

def approx_tokens(text: str) -> int:
    return len(text) // 4


# ── Main builder ─────────────────────────────────────────

def source_files_of(root: Path) -> list[Path]:
    return [f for f in walk_project(root) if f.suffix in ALL_EXTENSIONS]


def source_checksum(source_files: list[Path]) -> str:
    # trié : le checksum ne doit pas dépendre de l'ordre de priorité de la carte
    ordered = sorted(source_files, key=str)
    return hashlib.md5(
        "".join(str(f.stat().st_mtime) for f in ordered).encode()
    ).hexdigest()[:8]


def extract_signatures(fpath: Path) -> list[str]:
    if fpath.suffix in TS_EXTENSIONS:
        return extract_typescript(fpath)
    if fpath.suffix in PY_EXTENSIONS:
        return extract_python(fpath)
    if fpath.suffix in DART_EXTENSIONS:
        return extract_dart(fpath)
    if fpath.suffix in GO_EXTENSIONS:
        return extract_go(fpath)
    return []


def priority_key(root: Path, f: Path) -> tuple[int, float]:
    """Code de l'application (0) avant code partagé (1), puis le plus récent."""
    try:
        parts = f.relative_to(root).parts
    except ValueError:
        parts = f.parts
    shared = any(p in SHARED_DIRS for p in parts)
    return (1 if shared else 0, -f.stat().st_mtime)


_DECL_NAME = re.compile(
    r"^(?:\[[^\]]*\]\s*)?(?:[a-z]+\s+)*?(?:class|interface|enum|type|mixin|"
    r"extension|typedef|struct|func|fn)\s+(\w+)"
)


def declared_names(sigs: list[str]) -> list[str]:
    """Noms déclarés au premier niveau d'un fichier, à partir de ses signatures.

    Les déclarations de premier niveau ne sont pas indentées (classes, types…).
    Un fichier qui n'en a pas (composants React = fonctions seules) donne ses
    fonctions à la place.
    """
    names = []
    for line in sigs:
        if line.startswith(" "):
            continue
        m = _DECL_NAME.match(line)
        if m:
            names.append(m.group(1))
    if names:
        return names
    for line in sigs:
        m = re.match(r"^\s*(?:async\s+)?fn\s+(\w+)", line)
        if m:
            names.append(m.group(1))
    return names


def build_index(root: Path, entries: list[tuple[Path, list[str]]]) -> str:
    """Une ligne par fichier, groupés par répertoire : `fichier: Nom1, Nom2`."""
    by_dir: dict[Path, list[tuple[str, list[str]]]] = {}
    for fpath, sigs in entries:
        try:
            rel = fpath.relative_to(root)
        except ValueError:
            rel = fpath
        by_dir.setdefault(rel.parent, []).append((rel.name, declared_names(sigs)))

    lines: list[str] = []
    for d in sorted(by_dir):
        lines.append(f"{d}/")
        for name, decl in sorted(by_dir[d]):
            shown = ", ".join(decl[:INDEX_MAX_NAMES])
            more = f" +{len(decl) - INDEX_MAX_NAMES}" if len(decl) > INDEX_MAX_NAMES else ""
            lines.append(f"  {name}: {shown}{more}" if shown else f"  {name}")
    return "\n".join(lines)


def build_repo_map(
    root: Path, max_tokens: int = 8000, with_index: bool = True
) -> tuple[str, dict]:
    """
    Génère le repo map complet.
    Retourne (contenu_markdown, stats).
    """
    root = root.resolve()
    project_name = root.name
    all_files = list(walk_project(root))

    source_files = [f for f in all_files if f.suffix in ALL_EXTENSIONS]
    config_files = [f for f in all_files if f.name in CONFIG_FILES]

    source_files.sort(key=lambda f: priority_key(root, f))

    sections: list[str] = []

    # En-tête
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    checksum = source_checksum(source_files)

    sections.append(
        f"# Repo Map — {project_name}\n"
        f"Generated: {now} | Checksum: {checksum} | "
        f"Files: {len(source_files)} source + {len(config_files)} config\n"
    )

    # Config files
    config_lines = []
    for cf in config_files:
        try:
            rel = cf.relative_to(root)
        except ValueError:
            rel = cf
        items = extract_config(cf)
        if items:
            config_lines.append(f"\n### {rel}")
            config_lines.extend(f"  {item}" for item in items)

    if config_lines:
        sections.append("## Config\n" + "\n".join(config_lines))

    # Structure
    sections.append("## Structure\n" + build_tree(root, source_files))

    # Signatures — respecter le budget de tokens ; le reste va dans l'index
    sig_parts: list[str] = []
    indexed: list[tuple[Path, list[str]]] = []
    tokens_used = approx_tokens("\n\n".join(sections))
    files_included = 0

    for fpath in source_files:
        sigs = extract_signatures(fpath)
        if not sigs:
            continue

        try:
            rel = fpath.relative_to(root)
        except ValueError:
            rel = fpath
        entry = f"### {rel}\n" + "\n".join(sigs)
        entry_tokens = approx_tokens(entry)

        if tokens_used + entry_tokens > max_tokens:
            indexed.append((fpath, sigs))
            continue

        sig_parts.append(entry)
        tokens_used += entry_tokens
        files_included += 1

    if sig_parts:
        sections.append("## Signatures\n\n" + "\n\n".join(sig_parts))

    index_tokens = 0
    if indexed and with_index:
        index = build_index(root, indexed)
        index_tokens = approx_tokens(index)
        sections.append(
            "## Index\nFichiers hors budget de signatures : noms déclarés "
            "seulement. Ouvrir le fichier pour le détail.\n\n" + index
        )

    content = "\n\n".join(sections)
    stats = {
        "source_files": len(source_files),
        "files_included": files_included,
        "files_skipped": 0 if with_index else len(indexed),
        "files_indexed": len(indexed) if with_index else 0,
        "index_tokens": index_tokens,
        "config_files": len(config_files),
        "approx_tokens": approx_tokens(content),
        "checksum": checksum,
    }

    return content, stats


# ── CLI ──────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Génère un repo map compact pour les agents LLM"
    )
    parser.add_argument(
        "path", nargs="?", default=".", help="Racine du projet (défaut: répertoire courant)"
    )
    parser.add_argument(
        "--save", action="store_true", help=f"Sauvegarde dans {{project_root}}/{OUTPUT_FILENAME}"
    )
    parser.add_argument(
        "--output", help="Chemin de sortie alternatif"
    )
    parser.add_argument(
        "--max-tokens", type=int, default=8000, help="Budget tokens approximatif (défaut: 8000)"
    )
    parser.add_argument(
        "--no-index", action="store_true",
        help="Pas d'index : les fichiers hors budget sont simplement omis"
    )
    parser.add_argument(
        "--stats", action="store_true", help="Affiche les métriques de génération"
    )
    parser.add_argument(
        "--check", action="store_true",
        help="Vérifie si le repo map existant est à jour (exit 0=ok, 1=stale)"
    )
    args = parser.parse_args()

    root = Path(args.path)
    if not root.exists():
        print(f"Erreur : chemin introuvable : {root}", file=sys.stderr)
        sys.exit(1)

    # Mode --check : compare le checksum existant
    if args.check:
        existing = root / OUTPUT_FILENAME
        if not existing.exists():
            print("stale: fichier absent")
            sys.exit(1)
        checksum = source_checksum(source_files_of(root.resolve()))
        content = existing.read_text(encoding="utf-8")
        if checksum in content:
            print("up-to-date")
            sys.exit(0)
        else:
            print("stale: fichiers modifiés")
            sys.exit(1)

    content, stats = build_repo_map(
        root, max_tokens=args.max_tokens, with_index=not args.no_index
    )

    if args.stats:
        print(f"Fichiers source  : {stats['source_files']}", file=sys.stderr)
        print(f"Fichiers inclus  : {stats['files_included']}", file=sys.stderr)
        print(f"Fichiers indexés : {stats['files_indexed']} (~{stats['index_tokens']} tokens)", file=sys.stderr)
        print(f"Fichiers omis    : {stats['files_skipped']}", file=sys.stderr)
        print(f"Tokens approx.   : {stats['approx_tokens']}", file=sys.stderr)
        print(f"Checksum         : {stats['checksum']}", file=sys.stderr)

    output_path = None
    if args.output:
        output_path = Path(args.output)
    elif args.save:
        output_path = root / OUTPUT_FILENAME

    if output_path:
        output_path.write_text(content, encoding="utf-8")
        print(f"Repo map sauvegardé : {output_path} (~{stats['approx_tokens']} tokens)")
    else:
        print(content)


if __name__ == "__main__":
    main()
