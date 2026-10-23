# Runnel website

Private Astro static site, owned by this repository. It builds to `dist/` for a
`/runnel/` base path. There is no configured live URL, canonical URL, deployment
workflow, or npm publication step.

From the repository root, use Node 24.19.0 and npm 11.16.0:

```sh
npm ci
npm run dev:website -- --host 127.0.0.1
```

Open `http://127.0.0.1:4321/runnel/`. For a production build and local preview:

```sh
npm run build:website
npm run preview:website -- --host 127.0.0.1
```

Astro's preview server uses the same URL and port by default. Stop the dev server
before starting preview. A future hosting task can serve `apps/website/dist/`
under `/runnel/`; publishing is a separate maintainer decision.

`npm run build` builds the public TypeScript packages and this site. Root
`typecheck` runs `astro check` and strict TypeScript checking for the site, and
root `format:check` checks its Astro templates with Prettier. Biome owns CSS,
TypeScript, JSON, and JavaScript formatting and linting. Astro templates are
excluded from Biome because its partial frontmatter support reports template
imports and variables as unused; Astro checks their types and Prettier formats
the complete templates. `npm run verify` includes
these checks in the existing Linux and Windows CI baseline. Website dependencies
are pinned dev dependencies of this private workspace, excluded from the public
package release group and selected local-install tarballs. The site uses
TypeScript 6.0.3 because `@astrojs/check` 0.9.12 supports TypeScript 5 and 6; the
public packages keep their existing TypeScript 7 compiler.

Astro 7.4.2 supports Node >=22.23.4 and npm >=9.6.5, including this repository's
pinned runtime. See the [official installation requirements](https://docs.astro.build/en/install-and-setup/)
and [TypeScript checking guide](https://docs.astro.build/en/guides/typescript/).

## Copy and design

The CLI source and [CLI documentation](../cli/README.md) own command behavior.
Keep examples in sync with them. The result displayed on the site is illustrative,
with the envelope shape used by `apps/cli/src/mongodb-query.ts` and
`apps/cli/src/worker-protocol.ts`. No live database is queried by the site.

The visual reference is [Outpost](https://abijith-suresh.github.io/outpost/),
particularly its compact dark layout, IBM Plex typography, and understated blue
and green terminal examples. The Runnel page has its own content and layout.

The unmodified IBM Plex Sans variable Roman and IBM Plex Mono Regular WOFF2
files come from Outpost's `apps/website/src/assets/fonts/` at commit
`727d6bf66443e107b7566436bbedc58154a4b181`. They are self-hosted. Their copyright
notice and SIL Open Font License 1.1 are kept in `public/fonts/LICENSE.txt`,
which is included in every static build and linked from the footer. Font
redistribution must keep that notice and license.

## Browser review

At desktop and 320px mobile widths, check that terminal examples wrap without
page overflow. Tab through the skip link, navigation, CTAs, code regions, and copy
buttons. Check visible focus and reduced motion. Copy success announces its
status; clipboard failure explains manual copying and selects the source text.
Without JavaScript, copy buttons stay hidden and all content remains readable.
External links use normal same-tab navigation.
