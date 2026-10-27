# Issue report module (front)

## Rôle

Bouton « Signaler un problème » pour les **utilisateurs connectés** : un dialogue pour écrire le signalement (titre,
description), un toast avec le numéro attribué par le hub, et la liste « Mes signalements » avec leur état. Le back
(`nest/issue-report/README.md`) relaie au projet Agent Hub ; le navigateur ne voit jamais l'URL du hub ni le jeton.

## Structure

| Fichier | Rôle |
| --- | --- |
| `plugin.tsx` | `createIssueReportPlugin(options)` (`AppPluginFactory`, `pluginId = 'issue-report'`), exporté comme `plugin` : `HeaderActions = IssueReportButton`. Aucune route. |
| `components/IssueReportButton.tsx` | Bouton d'en-tête (icône, info-bulle), ouvre le dialogue. |
| `components/IssueReportDialog.tsx` | Dialogue à deux onglets : « Nouveau signalement » / « Mes signalements ». |
| `components/IssueReportForm.tsx` | Formulaire (titre, description), validation, envoi, toasts. |
| `components/MyIssueReports.tsx` | Liste des signalements de l'utilisateur. |
| `hooks/useIssueReportEnabled.ts` | `useIssueReportEnabled(active)` : lit la config du back une fois `active`. |
| `services/IssueReportApi.ts` | `issueReportApi` (appels HTTP), `resetIssueReportConfigCache()` (tests). |
| `utils/issueReportForm.ts` | Fonctions pures : `validateIssueReportForm`, `currentPageUrl`, `errorMessageKey`, `toneOf`, bornes. |
| `types/index.ts` | Types principaux. |
| `styles/tokens.css` | Jetons de couleur du module. |
| `locales/locales.{fr,en}.json` | Libellés (`issueReport.*`, français en « tu »), embarqués au build. |

## Services

Base : `configurationService.getApiUrl('issue-report')` (inclut `/api/v1`).

| Méthode | Endpoint | Description |
| --- | --- | --- |
| `issueReportApi.getConfig()` | `GET /issue-reports/config` | `{ enabled }`, mis en cache pour la page (un échec n'est pas mis en cache). |
| `issueReportApi.create(draft)` | `POST /issue-reports` | `{ title, description, pageUrl? }` → `{ number }`. `pageUrl` = origine + chemin de la page courante (jamais la query ni le fragment). Rejette avec la charge d'erreur d'`HttpService` (`statusCode`). |
| `issueReportApi.mine()` | `GET /issue-reports/mine` | `IssueReportItem[]` de l'utilisateur, plus récents d'abord. |

## Composants

- **`IssueReportButton`** `{ isAuth? }` : rendu seulement si l'utilisateur est connecté (`isAuth` du plugin, sinon
  `sessionAuth.isAuth()`), que l'appli a des comptes (`isUserManagementEnabled()` : ni clé admin ni mode local de
  confiance) et que le back répond `enabled: true`. `useSessionKeys(['user'])` : réagit à la connexion / déconnexion.
- **`IssueReportDialog`** `{ open, onClose, initialTab?: 'new' | 'mine' }` : fond flouté, fermeture et changement d'onglet
  bloqués pendant l'envoi.
- **`IssueReportForm`** `{ submitting, onSubmittingChange, onSent(number), onCancel }` : champs obligatoires marqués,
  erreurs à l'envoi (titre 3–200, description 1–10 000, compteurs), champs bloqués pendant l'envoi ; succès ⇒ toast
  « Ton signalement porte le numéro {n} » et fermeture ; échec ⇒ toast selon le code (`400` champs, `401` session
  expirée, `429` trop de signalements, `503` désactivé, autre ⇒ service injoignable).
- **`MyIssueReports`** : chargée à l'affichage de l'onglet ; numéro, titre, état (« En cours d'examen », « Corrigé »,
  « Non retenu », « Clos »), dates d'envoi et de clôture ; états chargement / vide / erreur (bouton Réessayer).

## Options du plugin (`front/src/config/pluginOptions.ts`)

| Option | Défaut | Effet |
| --- | --- | --- |
| `headerAction` | `true` | `false` : pas de bouton dans l'en-tête ; l'appli place `<IssueReportButton />` où elle veut. Valeur non booléenne ⇒ erreur au démarrage. |

## Types principaux

`IssueReportConfig { enabled }`, `IssueReportDraft { title, description, pageUrl? }`, `IssueReportCreated { number }`,
`IssueReportItem { id, number, title, status: 'open' | 'closed', closedReason: 'fixed' | 'dropped' | 'manual' | null,
closedAt, createdAt }`, `IssueReportHttpError { statusCode?, code? }`.

## Jetons (`styles/tokens.css`, défauts sur le contrat `common/theme/tokens.css`)

| Jeton | Défaut | Usage |
| --- | --- | --- |
| `--issue-report-button-bg` | `var(--header-pill)` | fond du bouton d'en-tête |
| `--issue-report-status-open-fg` | `var(--color-warning)` | état « En cours d'examen » |
| `--issue-report-status-fixed-fg` | `var(--color-success)` | état « Corrigé » |
| `--issue-report-status-dropped-fg` | `var(--color-text-muted)` | état « Non retenu » |
| `--issue-report-status-closed-fg` | `var(--color-text-muted)` | état « Clos » |
| `--issue-report-item-border` | `var(--color-border)` | séparateur de la liste |
| `--issue-report-item-meta-fg` | `var(--color-text-muted)` | numéro, dates |
| `--issue-report-form-hint-fg` | `var(--color-text-muted)` | textes d'aide du formulaire |

Un thème les surcharge dans son `colors.css`. Aucune couleur littérale dans les composants.

## Dépendances

`common` (`HttpService`, `ConfigurationService`, `sessionAuth`, `useSessionKeys`, `I18nLabel`, `i18n`, `ToastZone`,
`AppPlugin`), MUI et `@mui/icons-material` (base du gabarit). Le module back `issue-report` doit être lié aussi
(`node scripts/add-module.mjs issue-report` lie les deux).

## Tests

`plugin.spec.ts` (forme du plugin, option), `utils/issueReportForm.spec.ts` (validation, page, messages d'erreur,
états), `services/IssueReportApi.spec.ts` (URLs, cache de la config, rejets).
