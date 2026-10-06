# Changesets

Run `npm run changeset` on a development branch. Select an affected package and
choose **patch**, including for new functionality. The fixed group keeps all
three public packages aligned.

Every ordinary PR must add a nonempty patch Changeset. A version PR instead
consumes existing patch Changesets and advances the fixed group by one patch.
CI validates the actual diff; a release branch name does not bypass policy.

See [the release policy](../docs/RELEASING.md). This baseline has no pending
release and does not publish packages.
