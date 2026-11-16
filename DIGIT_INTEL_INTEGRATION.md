# ZONA Digit Intelligence — Integration Status

## Repository
- Repo: `zonasynthintel-lgtm/ZONA-WEBSITE`
- Safe branch: `feature/digit-intelligence-v2` (from `main`)
- Broken branch (do not use): `feature/digit-intelligence` — accidentally received a PLACEHOLDER index.html during a large-file upload failure. Leave it; prefer v2.

## What is already on GitHub (this branch)
- `digit-intel.js` — complete Stage 1 + Stage 2 strategy engine module:
  - Real observation processor + final-digit extraction
  - Independent rolling windows 100 / 500 / 1000
  - DIFFERS candidate (three-window unique lowest agreement) + sequential trigger 0→9 skipping candidate
  - EVEN/ODD with consecutive opposite count, Single/Continuous entry
  - OVER/UNDER (UNDER ≤ threshold, OVER > threshold) with same trigger model
  - MATCHES/DIFFERS statistics only (no auto entry)
  - Per-symbol isolation, event history, LocalStorage settings
  - Signal emission to existing AutoTrader via `tryAutoTrade(..., "DIGIT_INTEL", "DIGIT_INTEL")`
  - Manual digit trade helper calling `requestProposal` with digit contract context

## What must still be applied to `index.html`
Because `index.html` is ~3.3 MB, the GitHub file API path used by this session could not replace the whole file in one call after a failed placeholder write.

A fully integrated `index.html` was built locally with these surgical changes:

1. **UI card** — collapsible "ZONA DIGIT INTELLIGENCE" card in Trade section (after Quadrant Last Digit, before Signal notification preferences).
2. **processTick hook** — non-blocking feed:
   `window.ZonaDigitIntel.onTick({ symbol, quote, epoch, raw })`
3. **AutoTrader allowlists** — add `DIGIT_INTEL` alongside `P06_DIGIT_FLOW` / `QUADRANT_LAST_DIGIT` / `SIE_V1`.
4. **requestProposal** — if `setupType`/`signalSource` is `DIGIT_INTEL` or `zone._digitContract` is set, use that `contract_type` and optional `barrier` instead of CALL/PUT only.
5. **Script load** — either embed the engine or add:
   `<script src="digit-intel.js"></script>` before `</body>`.

## Contract types supported by the engine
| Strategy | Deriv contract_type | Barrier |
|----------|---------------------|---------|
| DIFFERS | DIGITDIFF | candidate digit |
| MATCHES (manual) | DIGITMATCH | selected digit |
| EVEN | DIGITEVEN | none |
| ODD | DIGITODD | none |
| OVER | DIGITOVER | threshold |
| UNDER | DIGITUNDER | threshold |

OVER/UNDER strategy classification: UNDER = digit ≤ threshold, OVER = digit > threshold. Verify against live Deriv barrier semantics on demo before real-money use.

## How to finish deployment
1. Download the fully integrated `index.html` from the build artifact provided in the implementation chat (or re-run the local integration script).
2. On branch `feature/digit-intelligence-v2`, replace `index.html` with that file (GitHub web UI upload or `git push`).
3. Open a PR → merge to `main` only after your review.
4. Vercel (if connected to `main`) will auto-deploy on merge.

## Safety
- `main` was never modified by this work.
- Existing Rise/Fall, AutoTrader, P0–P6, Quadrant, history, and risk controls are preserved in the integrated build.
- No PAT/credentials were written into source.
