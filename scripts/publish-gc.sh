#!/usr/bin/env sh
# Publish the @galacticcouncil chopsticks runtime packages to npm at their
# current version. Run from anywhere; it cd's to the repo root.
#
# Auth: token comes from ~/.yarnrc.yml (npmAuthToken). 2FA is enforced, so
# yarn will prompt for a one-time password (OTP) for EACH package. Enter a
# fresh code each time. If the interactive prompt misbehaves, append
# --otp=<code> to a command instead.
#
# Order matters: db and chopsticks depend on core@<version>, chopsticks on db.
set -e
cd "$(dirname "$0")/.."

echo "Publishing @galacticcouncil/* — you'll be asked for an OTP per package."

corepack yarn workspace @galacticcouncil/chopsticks-core npm publish --access public
corepack yarn workspace @galacticcouncil/chopsticks-db   npm publish --access public
corepack yarn workspace @galacticcouncil/chopsticks      npm publish --access public

echo "Done: published chopsticks-core, chopsticks-db, chopsticks."
