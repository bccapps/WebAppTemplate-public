# Module `mcp` (back, bibliothèque)

## Rôle

Transport seul pour exposer un endpoint MCP **sans état** depuis un contrôleur NestJS avec le SDK TypeScript MCP **v2**
(`@modelcontextprotocol/server` + `@modelcontextprotocol/node`). Pas d'authentification, pas de jeton, pas d'outils :
chaque appli garde son garde-fou (clé API, jeton, session), son principal, ses outils et sa facturation, et ne délègue ici
que l'écriture de la réponse HTTP.

Bibliothèque : importée par des contrôleurs d'autres modules, **sans plugin** (reste listée dans `shared-modules.json`
pour le lien symbolique). Aucun import de `common` ni de `database`.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `mcpHttp.ts` | `serveMcp(req, res, server)`, `rejectMcp(res, status, message)`, `rejectMcpMethod(res)`, `MCP_JSON_RPC_VERSION`. |
| `mcpResults.ts` | `mcpTextResult(value)` (un bloc texte JSON), `mcpErrorResult(message)` (`isError: true`). |
| `index.ts` | Réexporte les quatre fonctions et la constante. |

### API

| Export | Description |
| --- | --- |
| `serveMcp(req, res, server)` | Sert **une** requête `POST` avec un `McpServer` construit pour cette requête. Utilise `req.body` (déjà analysé par Express ; `rawBody` et `configureHttpApp` ne changent pas). Ferme le serveur (et le transport) à la fermeture de la réponse. |
| `rejectMcp(res, status, message)` | Corps d'erreur JSON-RPC `{ jsonrpc: '2.0', error: { code: -32000, message }, id: null }` avec le statut HTTP donné (401 pour une clé absente ou invalide, par exemple). |
| `rejectMcpMethod(res)` | `405` + `Allow: POST` (un serveur sans état n'a ni flux serveur `GET` ni session à clore `DELETE`). |
| `mcpTextResult(value)` / `mcpErrorResult(message)` | Résultats d'outil : succès sérialisé en JSON ; échec lisible par le modèle (`isError`). |

### Deux ères sur une seule URL

- **2026-07-28** (enveloppe `_meta` par requête) : `createMcpHandler(() => server, { legacy: 'reject' })` + `toNodeHandler`. `responseMode: 'json'` : toujours une réponse JSON ; les notifications de progression et de journal émises pendant un appel sont **abandonnées** (seul le résultat est livré).
- **2025-era** (`initialize`, 2025-11-25, 2025-06-18, 2025-03-26) : `NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`. Réponse **JSON simple** (sans SSE, sans notification en cours d'appel) (`application/json`), comme le SDK v1.
  Le repli intégré du SDK (`legacy: 'stateless'`) répondrait en SSE (`event: message`) faute d'option `enableJsonResponse` : c'est pour cela que la jambe 2025 est câblée ici avec `isLegacyRequest`.

Le routage vient du SDK (`isLegacyRequest`), sans réimplémentation.

## Dépendances

`@modelcontextprotocol/server` ^2.4.0, `@modelcontextprotocol/node` ^2.1.2 (`package.fragment.json`). `zod` (^4.2.0 requis par le SDK) n'est pas importé ici : il reste déclaré par le module qui définit les schémas d'outils. `express` (types) fourni par l'appli.

## Exemple d'usage

```ts
@Controller('/mcp')
export class McpController {
  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    const principal = await this.authenticate(req);            // à vous : 401 via rejectMcp(res, 401, '…')
    await serveMcp(req, res, this.factory.create(principal));  // un serveur PAR requête, lié au principal
  }

  @Get()
  notAllowed(@Res() res: Response): void { rejectMcpMethod(res); }

  @Delete()
  notAllowedDelete(@Res() res: Response): void { rejectMcpMethod(res); }
}
```

⚠️ Un décorateur de méthode par verbe : empiler `@Get() @Delete()` sur une même méthode n'enregistre que **GET** (le second écrase le premier), et `DELETE` répondrait 404 au lieu de 405. Un test qui monte les routes à la main (`app.delete(...)`) ne le voit pas : vérifier le routage Nest réel (métadonnée `method` de chaque handler).

Dans la fabrique : `new McpServer(info, { instructions })`, puis `registerTool(name, { inputSchema: z.object({...}) }, handler)`
(une forme brute `{ a: z.string() }` est une surcharge dépréciée : envelopper dans `z.object`), et le handler renvoie
`mcpTextResult(data)` ou, sur échec, `mcpErrorResult(message)`.

## Points d'extension et règles

- **Un serveur par requête** : ne jamais partager un `McpServer` entre requêtes (les outils sont liés au locataire/clé de l'appelant, donc à la facturation).
- **Les contrôles restent devant** : `createMcpHandler` ne valide ni jeton, ni `Host`, ni `Origin`. Throttle, authentification, `@Public()`, 405 sont dans le contrôleur de l'appli, avant `serveMcp`.
- Pour un besoin d'`authInfo` ou de filtre d'ère, étendre `serveMcp` plutôt que de recâbler le transport dans une appli.

## Changements de comportement par rapport au SDK v1

- **Outil inconnu** : `tools/call` sur un nom d'outil non enregistré répond une erreur de protocole JSON-RPC `-32602` (`ProtocolError`) et non plus un résultat `isError: true`. Les échecs *à l'intérieur* d'un outil restent des résultats `isError`.
- Les réponses 2026-07-28 portent des champs en plus (`resultType`, `_meta` avec `serverInfo`) ; sans effet pour un client 2025.
- `subscriptions/listen` (2026-07-28) est **refusé** en ligne (`maxSubscriptions: 0` : erreur JSON-RPC `-32603` « Subscription limit reached », réponse JSON, aucun flux SSE ouvert) : un endpoint sans état ne garde aucune connexion. `serveMcp` annonce aussi `tools.listChanged: false` pour ne pas inviter à écouter.
- `InMemoryTransport` ne teste que l'ère 2025 : tester l'ère 2026 par une vraie requête HTTP (voir `mcpHttp.spec.ts`).
