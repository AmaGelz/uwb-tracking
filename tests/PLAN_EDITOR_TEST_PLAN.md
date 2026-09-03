# Plan Editor acceptance test plan

Prerequisites: run the ordered database migrations, start FastAPI with the
simulator disabled, and sign in as an Admin. Use a disposable project/plan for
the destructive cases.

## AC1 — L-shaped boundary save/reload

1. Create a plan and choose **Plan Boundary**.
2. Draw at least six vertices in an L shape; close by clicking the first point.
3. Confirm Width/Height are read-only bounding-box values and Area is correct.
4. Save, reload the browser, and compare every row in Boundary vertices.

Expected: all points and the concave corner persist without distortion. Saving
is refused while a replacement boundary is still open.

## AC2 — Vertex editing and area

1. Select the plan boundary and drag a vertex.
2. Click an edge midpoint to insert a vertex; edit X/Y numerically.
3. Select a Zone and repeat; delete a vertex using Delete and right-click.

Expected: handles move with the pointer, bounds/area update immediately, and a
polygon cannot be reduced below three vertices.

## AC3 — Wall-mounted Anchor

1. Draw a boundary and an interior line.
2. Choose Anchor, Mount type **Wall-mounted**, and move within 0.3 m of each
   wall; confirm the candidate wall highlights.
3. Place the Anchor, drag it along the wall, change Z/orientation/facing side,
   save, and reload.

Expected: X/Y are projected onto the wall, wall reference/offset persist, and
the orientation arrow matches the saved degree value.

## AC4 — Ceiling/column/free Anchors

Place one Anchor for each type. Confirm ceiling Z defaults to plan ceiling
height, while column/free positions are unconstrained and allow explicit X/Y/Z.
Reload and compare the Properties values.

## AC5 — Overlapping Zones

1. Draw two overlapping polygons and one polygon that crosses the plan edge.
2. Give them different names/types/colors/opacities.
3. Use the Zone list to hide/show and bring front/send back.
4. Move an Anchor across each polygon.

Expected: overlap is allowed, the outside Zone warns but saves, stacking and
visibility persist, areas are correct, and “Anchors inside” updates.

## AC6 — Undo/Redo

For boundary, Zone, Anchor, Line/Rectangle, and Dimension operations, exercise
create, drag/group drag, vertex add/move/remove, property edit, rotate, and
delete. Use Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z after each operation, then reload.

Expected: both canvas and persisted API state follow undo/redo; a new edit
clears the redo stack.

## AC7 — Legacy compatibility

Before applying migration 005, create a plan containing only width/height and
Anchors without mount metadata. Apply migrations and open the editor.

Expected: boundary is `(0,0)-(width,height)`, Anchors default to `free`, Z and
orientation default to zero, legacy Zone bounds have polygon geometry, and
tracking pages load without errors.

## AC8 — Existing controls

With Plan/Zone/Anchor objects visible, verify Grid, Snap, Labels, wheel zoom,
Space/middle-button pan, zoom −/+/Fit, L, Esc, Delete, and Ctrl+D. Hold Shift
while drawing several edges and verify angles lock to 45-degree increments.

Expected: controls work at multiple zoom levels and persisted coordinates stay
in metres rather than screen pixels.

## Automated checks

Run:

```powershell
node --check SUPALAI-UWB-frontend/js/plan-editor.js
node --check SUPALAI-UWB-frontend/js/app.js
python -m compileall -q backend/backend migration tests
& .\.venv\Scripts\python.exe -m pytest tests -q --rootdir=tests
```

`test_plan_geometry.py` covers L-shape preservation, concave containment,
legacy rectangle conversion, object-form points, wall projection, and invalid
polygon rejection. `test_plan_api_normalisation.py` protects legacy
width/height and mount-height payloads, unchanged-boundary wall references,
and recalculated Dimension values. `test_plan_query_contracts.py` covers SQL
mutation parameters, migration ordering/metadata preservation, rollback, and
the ingestion/Undo contracts.

## Permanent data-integrity regressions

These cases are release gates. Keep them even if their UI paths appear to be
covered by broader acceptance tests: each protects persisted data that can look
normal in the editor while being silently corrupted in the database.

### DI-01 — Hardware ingestion preserves editor-owned Anchor metadata

1. Create an Anchor through the Plan Editor API with a non-default mount type,
   Z, orientation, and wall reference.
2. Send a signed `/api/hardware/ingest` position/status update for that Anchor.
3. Reload the Anchor from the API and compare all editor-owned fields.

Expected: ingestion may update telemetry fields such as battery and timestamp,
but must not overwrite `mount_type`, `z`, `orientation_deg`, or `wall_ref`.
Covered by `manual_plan_editor_e2e.py` against PostgreSQL and the SQL mutation
contract in `test_plan_query_contracts.py`.

### DI-02 — Boundary changes cannot leave an unreviewed stale wall reference

1. Attach a wall-mounted Anchor to a boundary edge.
2. Insert, remove, or move a boundary vertex and save the Plan.
3. Reload the Anchor.

Expected: the reference is either rebound to a verified edge or marked with
`needsReview: true` and `reviewReason: plan_boundary_changed`. The current
conservative behavior flags all boundary wall references for review. Interior
object-wall references are unaffected. Covered by both regression files.

### DI-03 — Polygon bounds remain synchronized on both read paths

After a boundary edit, reload `/api/plans/{plan_id}` and
`/api/projects/{project_id}` and compare their legacy `width_m`/`height_m` to
the polygon bounding box.

Expected: both endpoints return the same computed dimensions. Covered by
`plan_boundary_fields`, `test_plan_geometry.py`, query-contract tests, and the
manual browser/API harness.

### DI-04 — A new action invalidates the abandoned redo branch

Create two actions, undo the second, then create a different action. Confirm
Redo is disabled and invoking Redo does not restore the abandoned action.

Expected: the new action clears the redo stack. Covered by the JavaScript
contract test and an interactive browser assertion in
`manual_plan_editor_e2e.py`.

## Repeatable browser/API harness

With the test backend running and a matching `HARDWARE_INGEST_SECRET`, run the
API integrity suite first:

```powershell
& .\.venv\Scripts\python.exe tests\manual_plan_editor_e2e.py --skip-browser
```

For a short release-gate command that exercises DI-01 through DI-03 against
PostgreSQL, use `--skip-browser --api-stage integrity`; DI-04 is in the `zone`
browser stage below.

Then run the browser suite. On runners with short per-command limits, use the
two equivalent split stages:

```powershell
& .\.venv\Scripts\python.exe tests\manual_plan_editor_e2e.py --browser-only --browser-stage boundary --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
& .\.venv\Scripts\python.exe tests\manual_plan_editor_e2e.py --browser-only --browser-stage zone --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

The harness uses disposable `E2E-*` records and verifies cleanup at the end.
