#!/usr/bin/env bash
# report-realpack-skips.sh -- scans a `go test -v` log for tests that need an external pack set
# via FEATURELAB_PACK_DIR and skipped because it was not set. Such tests call
# `tb.Skipf("pack not available at %s: %v", packDir, err)` when the pack is absent, which it
# always is on a CI runner.
#
# Skipping there is CORRECT and this script never fails the build over it. Its only job is to
# make sure a green CI check is never silently mistaken for verification that did not happen:
# the placement baseline that does run in CI is TestFixtureDigest, over the fixture pack
# committed in this repo.
#
# Detection is by matching the literal Skipf message prefix, not a hardcoded test-name list, so
# a future test added under the same convention is picked up automatically without touching
# this script.
#
# Usage: report-realpack-skips.sh <go-test-v-log>
# Writes a summary to $GITHUB_STEP_SUMMARY (if set) and always exits 0.
set -euo pipefail

log="${1:?usage: report-realpack-skips.sh <go-test-v-log>}"
summary_target="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ ! -f "$log" ]; then
  echo "::warning::report-realpack-skips: log file $log not found -- go test may not have run at all"
  {
    echo "## External-pack test coverage"
    echo
    echo "**Could not check** -- $log does not exist, so either \`go test\` never ran or wrote its output somewhere else."
  } >>"$summary_target"
  exit 0
fi

mapfile -t skipped < <(awk '
  /pack not available at/ { pending = 1; next }
  /^--- SKIP: / && pending { print $3; pending = 0 }
' "$log")

{
  echo "## External-pack test coverage"
  echo
  if [ "${#skipped[@]}" -eq 0 ]; then
    echo "No suites matched the \"pack not available\" skip convention in this run's test output."
    echo "If that's unexpected, check the job log directly -- this script only greps for a literal string and could be out of sync with the test files."
  else
    printf '%s
' "The following suites need an external pack set via FEATURELAB_PACK_DIR, which is not available on CI runners, and therefore **skipped**, not ran:"
    echo
    for t in "${skipped[@]}"; do
      echo "- \`$t\`"
    done
    echo
    echo "> [!NOTE]"
    echo "> The placement baseline that DID run is \`TestFixtureDigest\`, over the fixture pack committed in this repo. It reaches every feature type the digest suite covers, but through a small corpus, so a placement regression is covered only thinly. To run the skipped suites, set FEATURELAB_PACK_DIR to a behavior pack locally (or on a self-hosted runner gated to trusted/manual triggers)."
  fi
} >>"$summary_target"

if [ "${#skipped[@]}" -gt 0 ]; then
  echo "::warning::${#skipped[@]} external-pack suite(s) skipped in this CI run because FEATURELAB_PACK_DIR is not set (this is expected) -- see the job summary for which ones. TestFixtureDigest, the baseline over the committed fixture pack, did run."
fi

exit 0
