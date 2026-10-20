# shellcheck shell=sh
# shellcheck disable=SC2154,SC2155 # umbrelOS provides app_entropy_identifier and derive_entropy
# Sourced by umbrelOS before docker compose runs. derive_entropy gives a value that is stable for this
# install and survives updates, so the JWT secret is generated on the device and never stored here.
export APP_THIEVES_OBSIDIAN_TC_JWT_SECRET="$(derive_entropy "${app_entropy_identifier}-jwt-secret")"
