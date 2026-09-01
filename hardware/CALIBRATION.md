# DW1000 antenna delay calibration

## Why this matters
Each DW1000 radio's antenna and analog front-end add a small, fixed hardware
delay between the internal timestamp of a bit and when its RF energy
actually leaves/arrives at the antenna, and because every reported range is
computed directly from those timestamps, a few tens of uncorrected ticks
show up as a constant, multi-centimeter-to-decimeter offset in *every*
reading from that device.

## Current state (as of this doc)
`anchor_1782/1783/1784.ino` and `tag.ino` now call `DW1000.setAntennaDelay()`
with an explicit `#define ANTENNA_DELAY 16384` placeholder — same as the
library's implicit fallback, so there's no behavior change yet. Replace each
anchor's placeholder with its own calibrated value once real hardware exists
and the procedure below has been run.

## API recap
- `DW1000.setAntennaDelay(uint16_t value)` — raw DW1000 clock ticks
  (0-65535), NOT nanoseconds. `DW1000.getAntennaDelay()` reads it back.
- **Ordering constraint**: `DW1000Ranging` has no antenna-delay method of
  its own. You must call `DW1000.setAntennaDelay(...)` yourself, and it
  MUST happen after `DW1000Ranging.initCommunication(...)` but BEFORE
  `DW1000Ranging.startAsAnchor(...)` / `startAsTag(...)` — the value is
  only written to the chip inside `commitConfiguration()`, which those
  start calls trigger internally. Calling it after start silently does
  nothing.
- Tick <-> distance conversion the library itself uses internally:
  `TIME_RES = 0.000015650040064103` us/tick and
  `DISTANCE_OF_RADIO = 0.0046917639786159` m/tick (~4.69mm/tick). This doc
  uses `DISTANCE_OF_RADIO` **only** as a first-guess step size for picking a
  second calibration trial — see "The uncertainty" below for why it is not
  trusted as the final answer.

## The uncertainty this procedure is designed around
Two-way ranging folds antenna delay into a round-trip time-of-flight
formula. Adjusting ONE device's antenna delay by `deltaN` ticks shifts the
*reported* range by some factor that depends on exactly how
`DW1000Ranging`'s specific TWR arithmetic uses that delay (e.g. whether it's
applied once per leg, subtracted symmetrically on both legs, etc.). That
internal formula was not traced from source for this project (no compiler
and no local copy of the vendored library exist in this environment to
verify it against), so **this procedure never assumes `deltaN * DISTANCE_OF_RADIO`
is the true answer** — it uses that value only to pick a reasonably-sized
second trial step, then *measures* the real local sensitivity from two
actual ranging results before computing the final correction. This
empirical-not-formula approach also matches established practice for this
exact chip/board family: Makerfabs' own antenna-delay-calibration guidance
points to a reference implementation
(`jremington/UWB-Indoor-Localization_Arduino`) whose auto-calibration sketch
also determines the correction purely by comparing measured vs. taped
distance, with no tick-to-meter formula in the code at all.

## Which device(s) to calibrate — per-anchor, not one shared value
**Leave the tag at the library default (16384) always, and calibrate each
anchor individually against it.** This is the documented convention from
Makerfabs' own blog for this exact board family, and from the reference
auto-calibration sketch they point customers to, which states plainly:
"Each anchor must be individually calibrated!" Their real-world numbers:
anchors calibrated against a tag held at 16384 land in the **16550-16650**
range, giving **±10cm accuracy over 1-8m**.

Why *not* a "one shared value copied across all 4 devices" shortcut: if the
round-trip formula folds a device's antenna delay in symmetrically
(unverified, see above), the ONE calibrated number you derive by varying
just one device against a default-valued partner already encodes "how much
THIS device's error plus the OTHER (untouched) device's error needs
correcting" — it is not necessarily that device's own true delay in
isolation. Copying that same absolute number onto a *different* device
(e.g. onto the other two anchors, which were never part of the trial) risks
double-correcting or under-correcting, with no way to check without
hardware. Per-anchor calibration sidesteps that assumption entirely: each
anchor's number is validated against the exact same fixed reference (the
tag at 16384) it will actually run against in production.

The shortcut worth flagging as an explicit downgrade, not an upgrade: skip
individual anchor calibration and reuse one anchor's derived value on the
other two, betting this hardware batch is unusually consistent
device-to-device. Only do this after running the full procedure once, if
you're consciously trading accuracy for time on the remaining anchors.

## Physical setup requirements
- Known LOS (line-of-sight) reference distance, measured with a tape
  measure or laser rangefinder to roughly ±1cm, on the order of a few
  meters (3-8m) — similar to the actual anchor-tag separations expected in
  the real deployment. Too short a distance amplifies relative timing
  noise; matching real deployment scale keeps the calibration relevant.
- Open area, away from metal objects, walls, and other large flat/reflective
  surfaces that cause multipath. Outdoors or a large room is preferable to
  a small room.
- Anchor and tag antennas at the same height and orientation, elevated
  roughly 1m off the ground to reduce ground-bounce multipath.
- Only ONE anchor powered on during any given session — power off the
  other two physical anchor boards (or don't flash them yet) so the tag is
  only ever ranging against the one anchor you're calibrating.
- Let each trial run long enough for the printed running average
  (`AVG_WINDOW` = 10 samples by default) to visibly settle before reading
  it off — roughly 30+ raw samples per trial is a reasonable minimum.

## Step-by-step procedure (repeat once per anchor)
1. Flash `calib_tag/calib_tag.ino` onto the tag board (unchanged,
   `ANTENNA_DELAY` stays 16384 for the whole session).
2. Flash `calib_anchor/calib_anchor.ino` onto the anchor board you're
   calibrating, with `ANCHOR_ADD` set to that anchor's real address (see
   `MAPPING.md`) and `ANTENNA_DELAY` left at 16384 for trial 1.
3. Set up the fixed LOS distance `D_true` per "Physical setup requirements"
   above.
4. **Trial 1**: power both boards, let the running average settle, record
   `N1 = 16384` and `R1 =` the settled average range (meters).
5. Pick a trial step `deltaN_trial` using `DISTANCE_OF_RADIO` (~4.69mm/tick)
   only as a rough size guide — e.g. if `R1` is off from `D_true` by
   roughly 0.3m, `0.3 / 0.0046917639786159 ≈ 64` ticks gives a ballpark;
   round up to something comfortably larger than sample noise, e.g. 50-150
   ticks, so the resulting shift is clearly visible above per-sample jitter.
6. **Trial 2**: reflash `calib_anchor.ino` with
   `ANTENNA_DELAY = N2 = N1 + deltaN_trial` (anchor only — tag untouched).
   Let it settle, record `R2`.
7. Compute the empirical local sensitivity:
   `k_empirical = (R2 - R1) / (N2 - N1)` (meters/tick). Sanity-check: if
   this is wildly different in magnitude from `DISTANCE_OF_RADIO` (say,
   more than ~5x larger/smaller) or an unexpected sign, suspect a
   measurement-setup problem (multipath, movement, wrong `D_true`) before
   trusting it — re-measure before proceeding.
8. Compute the required correction and final value, from either trial as a
   cross-check (both should agree up to sample noise):
   `deltaN_needed_1 = (D_true - R1) / k_empirical`, final `= N1 + deltaN_needed_1`
   `deltaN_needed_2 = (D_true - R2) / k_empirical`, final `= N2 + deltaN_needed_2`
   Round to the nearest integer tick.
9. Reflash `calib_anchor.ino` with that final `ANTENNA_DELAY` and confirm
   the running average now sits close to `D_true` (ideally within a few cm,
   matching the ±10cm figure reported elsewhere for this hardware).
10. Optional but recommended validation: move the anchor/tag to a second,
    different `D_true` (e.g. roughly double the first) and confirm the
    calibrated value still reads close to that new true distance. A
    correctly-calibrated antenna delay should be accurate at any distance,
    not just the one it was tuned against — if it isn't, suspect multipath
    at the original test location rather than antenna delay itself.
11. Record the final calibrated value in the table below, then repeat steps
    2-10 for the next anchor (**skip step 1** — the tag board stays on
    `calib_tag.ino` for the entire session across all anchors, no need to
    reflash it between them).
12. Reflash **each anchor board** back to its real `anchor_17XX.ino` (see
    "Applying it to production" below) with that anchor's calibrated value
    filled in.
13. **Also reflash the tag board back to `tag.ino`** (its WiFi/server/tag_id
    settings are still in that file, untouched). This is easy to forget
    since it's not "another anchor to redo" — it's a one-time step at the
    very end. Uploading a new sketch completely replaces whatever a board
    was running before (a microcontroller only ever runs one program at a
    time), so the tag board is still running `calib_tag.ino` — which has no
    WiFi/JSON code at all — until you flash `tag.ino` back onto it.
    Skipping this means `positioning_server.py` will never see a connection
    from the tag when you get to running the real system.

### Calibrated value tracking table (fill in once real hardware exists)
| Anchor | ANCHOR_ADD | D_true used | Final calibrated ANTENNA_DELAY |
|---|---|---|---|
| anchor_1782 | `82:17:5B:D5:A9:9A:E2:9C` | 4.25 m | **16583** (via Jim Remington autocalibrate binary search) |
| anchor_1783 | `83:17:5B:D5:A9:9A:E2:9C` | 4.25 m | **16573** (via Jim Remington autocalibrate binary search) |
| anchor_1784 | `84:17:5B:D5:A9:9A:E2:9C` | TBD | TBD |
| tag | `7D:00:22:EA:82:60:3B:9C` | n/a (fixed reference) | 16384 (library default, unchanged) |

## Worked example — ILLUSTRATIVE ONLY, NOT A REAL MEASUREMENT
The numbers below are invented purely to demonstrate the arithmetic in
steps 7-8. **Do not flash any value from this section to real hardware.**
No physical measurement has been taken — hardware for this project has not
arrived yet.

- `D_true = 3.000 m` (hypothetical taped distance)
- Trial 1: `N1 = 16384`. Settled running average: `R1 = 3.245 m`.
- Trial step: `deltaN_trial = 100` ticks (an illustrative round choice).
- Trial 2: `N2 = 16484`. Settled running average: `R2 = 2.938 m`.
- `k_empirical = (2.938 - 3.245) / (16484 - 16384) = -0.307 / 100 = -0.00307 m/tick`
  (~-3.07mm/tick — illustrative note: this differs from the raw
  `DISTANCE_OF_RADIO` figure of ~4.69mm/tick by roughly a factor of 2/3,
  which is exactly the kind of library-specific proportionality difference
  this procedure exists to measure rather than assume.)
- Cross-check from trial 1: `deltaN_needed_1 = (3.000 - 3.245) / -0.00307 ≈ 79.8`
  -> final `≈ 16384 + 80 = 16464`.
- Cross-check from trial 2: `deltaN_needed_2 = (3.000 - 2.938) / -0.00307 ≈ -20.2`
  -> final `≈ 16484 - 20 = 16464`.
- Both cross-checks agree (16464), which is the internal-consistency check
  step 8 is meant to catch — **again, 16464 here is a fabricated
  illustration, not a real calibrated value.**

## Applying the result to production
- In each `anchor_17XX.ino`, replace the placeholder
  `#define ANTENNA_DELAY 16384` with that specific anchor's own calibrated
  value from the table above. Do not copy one anchor's value onto another.
- In `tag.ino`, leave `#define ANTENNA_DELAY 16384` as-is (library default)
  — per the convention above, the tag is the fixed reference and is not
  itself recalibrated.
- If you later discover a stubborn residual bias that per-anchor
  calibration against a fixed tag can't remove (e.g. a genuinely
  tag-side delay problem), some Decawave documentation instead recommends
  setting the tag's delay to 0 and calibrating anchors from there —
  untested here, and a deviation from the convention this doc defaults to,
  so treat it as a fallback investigation, not a first step.

## What isn't fully verified here
- The exact tick-to-meter proportionality used internally by
  `DW1000Ranging`'s TWR formula — deliberately not asserted; the two-point
  procedure above measures it per-setup instead.
- Whether the Makerfabs `mf_DW1000.zip` library (the one actually installed
  per this project's setup instructions) is byte-for-byte the same as
  thotro/arduino-dw1000 internally for `commitConfiguration()`/antenna
  delay handling. It's a documented fork/derivative and its public API
  (`DW1000Ranging`, `DW1000.setAntennaDelay`, `MODE_LONGDATA_RANGE_LOWPOWER`,
  etc.) matches thotro's exactly, and the community calibration guidance
  cited above is specifically written for this Makerfabs fork, but the
  internal `commitConfiguration()` source was not independently re-read
  here (no local copy exists on this machine, and it's runtime behavior
  that needs real hardware to confirm regardless).
- DW1000 timing is known to have some temperature dependency; calibrate at
  roughly the temperature/environment the system will actually run in.
