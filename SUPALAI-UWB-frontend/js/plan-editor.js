/* SUPALAI Plan Editor
 *
 * The model, pointer coordinates, viewport and snap spacing in this file are
 * all metres. CSS pixels are used only to keep handles, labels and hit targets
 * readable on screen; they never become persisted geometry.
 */
'use strict';

(() => {
  const { api, state: session } = window.SUPALAI_API;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EDIT_TOOLS = new Set(['line', 'boundary', 'rectangle', 'zone', 'anchor', 'dimension']);

  const ui = {
    svg: document.getElementById('editor-svg'),
    canvasWrap: document.getElementById('canvas-wrap'),
    background: document.getElementById('canvas-background'),
    gridLayer: document.getElementById('grid-layer'),
    minorGrid: document.getElementById('minor-grid-fill'),
    majorGrid: document.getElementById('major-grid-fill'),
    minorPattern: document.getElementById('minor-grid-pattern'),
    majorPattern: document.getElementById('major-grid-pattern'),
    minorPath: document.getElementById('minor-grid-path'),
    majorPath: document.getElementById('major-grid-path'),
    boundaryLayer: document.getElementById('plan-boundary-layer'),
    zoneLayer: document.getElementById('zone-layer'),
    objectLayer: document.getElementById('object-layer'),
    dimensionLayer: document.getElementById('dimension-layer'),
    anchorLayer: document.getElementById('anchor-layer'),
    draftLayer: document.getElementById('draft-layer'),
    guideLayer: document.getElementById('guide-layer'),
    loading: document.getElementById('editor-loading'),
    message: document.getElementById('editor-message'),
    cursor: document.getElementById('cursor-coords'),
    zoom: document.getElementById('zoom-level'),
    planTitle: document.getElementById('plan-title'),
    planMeta: document.getElementById('plan-meta'),
    projectSelect: document.getElementById('project-select'),
    planSelect: document.getElementById('plan-select'),
    newPlan: document.getElementById('new-plan'),
    editPlan: document.getElementById('edit-plan'),
    savePlan: document.getElementById('save-plan'),
    planSettings: document.getElementById('plan-settings'),
    planInput: document.getElementById('plan-id-input'),
    planNameInput: document.getElementById('plan-name-input'),
    planWidthInput: document.getElementById('plan-width-input'),
    planHeightInput: document.getElementById('plan-height-input'),
    planCeilingInput: document.getElementById('plan-ceiling-input'),
    planAreaOutput: document.getElementById('plan-area-output'),
    planVertexTable: document.getElementById('plan-vertex-table'),
    drawBoundary: document.getElementById('draw-boundary'),
    planVersionInput: document.getElementById('plan-version-input'),
    planActiveInput: document.getElementById('plan-active-input'),
    selectionSummary: document.getElementById('selection-summary'),
    selectionDetails: document.getElementById('selection-details'),
    anchorSettings: document.getElementById('anchor-settings'),
    anchorSettingsTitle: document.getElementById('anchor-settings-title'),
    anchorIdInput: document.getElementById('anchor-id-input'),
    anchorHardwareInput: document.getElementById('anchor-hardware-input'),
    anchorZInput: document.getElementById('anchor-z-input'),
    anchorMountInput: document.getElementById('anchor-mount-input'),
    anchorMountTypeInput: document.getElementById('anchor-mount-type-input'),
    anchorOrientationInput: document.getElementById('anchor-orientation-input'),
    anchorWallRefField: document.getElementById('anchor-wall-ref-field'),
    anchorWallRefOutput: document.getElementById('anchor-wall-ref-output'),
    anchorFacingInput: document.getElementById('anchor-facing-input'),
    anchorGatewayInput: document.getElementById('anchor-gateway-input'),
    anchorTagInput: document.getElementById('anchor-tag-input'),
    saveAnchorProperties: document.getElementById('save-anchor-properties'),
    zoneSettings: document.getElementById('zone-settings'),
    zoneNameInput: document.getElementById('zone-name-input'),
    zoneTypeInput: document.getElementById('zone-type-input'),
    zoneColorInput: document.getElementById('zone-color-input'),
    zoneOpacityInput: document.getElementById('zone-opacity-input'),
    zoneAreaOutput: document.getElementById('zone-area-output'),
    zoneAnchorsOutput: document.getElementById('zone-anchors-output'),
    saveZoneProperties: document.getElementById('save-zone-properties'),
    vertexSettings: document.getElementById('vertex-settings'),
    vertexXInput: document.getElementById('vertex-x-input'),
    vertexYInput: document.getElementById('vertex-y-input'),
    saveVertexProperties: document.getElementById('save-vertex-properties'),
    zoneList: document.getElementById('zone-list'),
    lineSettings: document.getElementById('line-settings'),
    lineLengthInput: document.getElementById('line-length-input'),
    lineAngleInput: document.getElementById('line-angle-input'),
    saveLineProperties: document.getElementById('save-line-properties'),
    precisionForm: document.getElementById('precision-input'),
    precisionTitle: document.getElementById('precision-title'),
    precisionLength: document.getElementById('precision-length'),
    precisionAngle: document.getElementById('precision-angle'),
    precisionApply: document.getElementById('precision-apply'),
    hardwareSettings: document.getElementById('hardware-settings'),
    gatewayDeviceInput: document.getElementById('gateway-device-input'),
    hardwareTagInput: document.getElementById('hardware-tag-input'),
    registerHardware: document.getElementById('register-hardware'),
    counts: document.getElementById('entity-counts'),
    gridSize: document.getElementById('grid-size'),
    roleHint: document.getElementById('editor-role-hint'),
    userName: document.getElementById('editor-user-name'),
    userMeta: document.getElementById('editor-user-meta'),
    avatar: document.getElementById('editor-avatar'),
    logout: document.getElementById('editor-logout'),
  };

  const state = {
    projects: [],
    plan: null,
    objects: [],
    zones: [],
    anchors: [],
    dimensions: [],
    tool: 'select',
    selected: null,
    selections: [],
    selectedVertex: null,
    draft: null,
    drag: null,
    pan: null,
    spaceDown: false,
    gridVisible: true,
    snapEnabled: true,
    labelsVisible: true,
    angleSnapEnabled: false,
    gridStep: 1,
    isAdmin: false,
    editMode: false,
    isNewPlan: false,
    canEdit: false,
    busy: false,
    zoneNameOpen: false,
    view: { x: -1, y: -1, width: 22, height: 22 },
    fitWidth: 22,
    undoStack: [],
    redoStack: [],
    clipboard: [],
    marquee: null,
    wallCandidate: null,
  };

  function svgElement(tag, attrs = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) element.setAttribute(name, String(value));
    }
    return element;
  }

  function clearLayer(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  function setMessage(text, kind = '') {
    ui.message.textContent = text;
    ui.message.className = kind ? `is-${kind}` : '';
  }

  function showLoading(text, isError = false) {
    ui.loading.hidden = false;
    ui.loading.textContent = text;
    ui.loading.classList.toggle('is-error', isError);
  }

  function hideLoading() {
    ui.loading.hidden = true;
    ui.loading.classList.remove('is-error');
  }

  function widthMetres() {
    return Math.max(0.01, planBounds().width);
  }

  function heightMetres() {
    return Math.max(0.01, planBounds().height);
  }

  function boundaryPoints() {
    const points = pointsFromGeometry(state.plan?.boundary);
    if (points.length >= 3) return points;
    const width = Math.max(0.01, Number(state.plan?.width_m) || 20);
    const height = Math.max(0.01, Number(state.plan?.height_m) || 20);
    return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  }

  function boundsForPoints(points) {
    const xs = points.map(point => Number(point.x));
    const ys = points.map(point => Number(point.y));
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    return { xMin, xMax, yMin, yMax, width: xMax - xMin, height: yMax - yMin };
  }

  function planBounds() {
    return boundsForPoints(boundaryPoints());
  }

  function polygonArea(points) {
    if (points.length < 3) return 0;
    return Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2);
  }

  // World coordinates are Cartesian metres (Y grows upward). SVG Y grows
  // downward, so this is the only axis conversion used by render functions.
  const svgY = worldY => planBounds().yMax - worldY;
  const worldY = svgCoordinateY => planBounds().yMax - svgCoordinateY;

  function canvasRect() {
    return ui.svg.getBoundingClientRect();
  }

  function metresPerPixel() {
    const rect = canvasRect();
    return state.view.width / Math.max(1, rect.width);
  }

  function pointerMetres(event, applySnap = false) {
    const rect = canvasRect();
    const sx = state.view.x + ((event.clientX - rect.left) / Math.max(1, rect.width)) * state.view.width;
    const sy = state.view.y + ((event.clientY - rect.top) / Math.max(1, rect.height)) * state.view.height;
    const point = { x: sx, y: worldY(sy) };
    return applySnap ? snapPoint(point) : point;
  }

  function snapPoint(point) {
    if (!state.snapEnabled) return point;
    const step = state.gridStep;
    return {
      x: Math.round(point.x / step) * step,
      y: Math.round(point.y / step) * step,
    };
  }

  function snapAnglePoint(start, point, force = false) {
    if (!start || (!force && !state.angleSnapEnabled)) return point;
    const { length, angle } = measurement(start, point);
    const snappedAngle = Math.round(angle / 45) * 45;
    const radians = snappedAngle * Math.PI / 180;
    return { x: start.x + length * Math.cos(radians), y: start.y + length * Math.sin(radians) };
  }

  function pointString(points) {
    return points.map(point => `${point.x},${svgY(point.y)}`).join(' ');
  }

  function pointsFromGeometry(geometry) {
    if (!geometry || !Array.isArray(geometry.points)) return [];
    return geometry.points
      .filter(point => Array.isArray(point) && point.length >= 2)
      .map(point => ({ x: Number(point[0]), y: Number(point[1]) }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  function geometryFromPoints(type, points) {
    return { type, points: points.map(point => [point.x, point.y]) };
  }

  function measurement(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return {
      length: Math.hypot(dx, dy),
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
    };
  }

  function activeSegment() {
    if (['zone', 'boundary'].includes(state.draft?.kind) && state.draft.points?.length) {
      return {
        kind: state.draft.kind,
        start: state.draft.points[state.draft.points.length - 1],
        end: state.draft.cursor,
      };
    }
    if (['line', 'dimension'].includes(state.draft?.kind) && state.draft.start) {
      return { kind: state.draft.kind, start: state.draft.start, end: state.draft.end };
    }
    return null;
  }

  function compactNumber(value, digits = 4) {
    return Number(value).toFixed(digits).replace(/\.?0+$/, '');
  }

  function syncPrecisionInput(force = false) {
    const segment = activeSegment();
    ui.precisionForm.hidden = !segment;
    if (!segment) return;

    const names = { line: 'Line segment', zone: 'Zone edge', boundary: 'Boundary edge', dimension: 'Dimension' };
    const actions = { line: 'Add line', zone: 'Add edge', boundary: 'Add edge', dimension: 'Set' };
    ui.precisionTitle.textContent = names[segment.kind];
    ui.precisionApply.textContent = actions[segment.kind];
    if (!segment.end || (!force && ui.precisionForm.contains(document.activeElement))) return;
    const { length, angle } = measurement(segment.start, segment.end);
    ui.precisionLength.value = compactNumber(length);
    ui.precisionAngle.value = compactNumber(angle);
  }

  function focusPrecisionLength() {
    requestAnimationFrame(() => {
      if (ui.precisionForm.hidden) return;
      ui.precisionLength.focus({ preventScroll: true });
      ui.precisionLength.select();
    });
  }

  function previewPrecisionInput() {
    const segment = activeSegment();
    const length = Number(ui.precisionLength.value);
    const angle = Number(ui.precisionAngle.value);
    if (!segment || !Number.isFinite(length) || length <= 0 || !Number.isFinite(angle)) return;
    const radians = angle * Math.PI / 180;
    const end = {
      x: segment.start.x + length * Math.cos(radians),
      y: segment.start.y + length * Math.sin(radians),
    };
    if (['zone', 'boundary'].includes(segment.kind)) state.draft.cursor = end;
    else state.draft.end = end;
    renderDraft();
  }

  function linePoints(object) {
    if (!object) return [];
    const type = String(object.geometry?.type || object.object_type || '').toLowerCase();
    const points = pointsFromGeometry(object.geometry);
    return type === 'line' && points.length >= 2 ? points.slice(0, 2) : [];
  }

  function entityGroup(kind, id) {
    const selected = isSelected(kind, id);
    const group = svgElement('g', {
      class: `editor-entity${selected ? ' is-selected' : ''}${selected && state.selections.length > 1 ? ' is-multi-selected' : ''}`,
      'data-kind': kind,
      'data-id': id,
    });
    return group;
  }

  function isSelected(kind, id) {
    return state.selections.some(selection => (
      selection.kind === kind && String(selection.id) === String(id)
    )) || Boolean(state.selected && state.selected.kind === kind && String(state.selected.id) === String(id));
  }

  function selectionKey(selection) {
    return `${selection.kind}:${selection.id}`;
  }

  function syncPrimarySelection() {
    state.selected = state.selections[state.selections.length - 1] || null;
    if (!state.selected) state.selectedVertex = null;
  }

  function addVertexHandles(group, kind, id, points) {
    if (!isSelected(kind, id) || !state.canEdit) return;
    const scale = visualScale();
    points.forEach((point, index) => {
      const handle = svgElement('circle', {
        class: `vertex-handle${state.selectedVertex?.kind === kind && String(state.selectedVertex.id) === String(id) && state.selectedVertex.index === index ? ' is-active' : ''}`,
        cx: point.x, cy: svgY(point.y), r: scale.handle,
        'data-kind': kind, 'data-id': id, 'data-vertex-index': index,
      });
      group.appendChild(handle);
      const next = points[(index + 1) % points.length];
      group.appendChild(svgElement('circle', {
        class: 'edge-handle',
        cx: (point.x + next.x) / 2, cy: svgY((point.y + next.y) / 2), r: scale.handle * 0.72,
        'data-kind': kind, 'data-id': id, 'data-edge-index': index,
      }));
    });
  }

  function visualScale() {
    const unit = metresPerPixel();
    return {
      label: unit * 11,
      anchor: unit * 7,
      handle: unit * 4,
      tick: unit * 5,
      offset: unit * 8,
    };
  }

  function addLabel(group, text, x, y, anchor = 'start') {
    if (!text || !state.labelsVisible) return;
    const scale = visualScale();
    const label = svgElement('text', {
      class: 'entity-label',
      x,
      y,
      'font-size': scale.label,
      'text-anchor': anchor,
    });
    label.textContent = text;
    group.appendChild(label);
  }

  function renderBoundary() {
    clearLayer(ui.boundaryLayer);
    if (!state.plan) return;
    const points = boundaryPoints();
    const group = entityGroup('boundary', state.plan.plan_id || 'draft-plan');
    group.appendChild(svgElement('polygon', {
      class: `plan-boundary${isSelected('boundary', state.plan.plan_id || 'draft-plan') ? ' is-selected' : ''}`,
      points: pointString(points),
    }));
    addVertexHandles(group, 'boundary', state.plan.plan_id || 'draft-plan', points);
    ui.boundaryLayer.appendChild(group);

    const scale = visualScale();
    const origin = svgElement('text', {
      class: 'plan-axis',
      x: planBounds().xMin + scale.offset,
      y: svgY(planBounds().yMin) - scale.offset,
      'font-size': scale.label * 0.9,
    });
    origin.textContent = '0, 0 m';
    ui.boundaryLayer.appendChild(origin);
  }

  function renderObjects() {
    clearLayer(ui.objectLayer);
    const scale = visualScale();
    state.objects.forEach(object => {
      const id = object.object_id;
      const group = entityGroup('object', id);
      const geometry = object.geometry || {};
      const type = String(geometry.type || object.object_type || '').toLowerCase();
      const points = pointsFromGeometry(geometry);
      let shape = null;
      let labelX = 0;
      let labelY = 0;

      if (type === 'rectangle' && Number.isFinite(Number(geometry.x))) {
        const x = Number(geometry.x);
        const y = Number(geometry.y);
        const width = Math.abs(Number(geometry.width) || 0);
        const height = Math.abs(Number(geometry.height) || 0);
        shape = svgElement('rect', {
          class: 'editor-shape object-shape object-rectangle',
          x,
          y: svgY(y + height),
          width,
          height,
        });
        labelX = x + width / 2;
        labelY = svgY(y + height / 2) - scale.offset;
      } else if (points.length >= 2) {
        const closed = type === 'polygon';
        shape = svgElement(closed ? 'polygon' : 'polyline', {
          class: 'editor-shape object-shape',
          points: pointString(points),
          fill: closed ? 'rgba(71,84,103,.04)' : 'none',
        });
        labelX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        labelY = svgY(points.reduce((sum, point) => sum + point.y, 0) / points.length) - scale.offset;
      }

      if (!shape) return;
      group.appendChild(shape);
      // Unnamed construction lines should stay visually quiet. Showing the
      // object type on every segment quickly covers an irregular floor plan.
      addLabel(group, object.label, labelX, labelY, 'middle');
      ui.objectLayer.appendChild(group);
    });
  }

  function zonePoints(zone) {
    const geometryPoints = pointsFromGeometry(zone.geometry);
    if (geometryPoints.length >= 3) return geometryPoints;
    return [
      { x: Number(zone.x_min), y: Number(zone.y_min) },
      { x: Number(zone.x_max), y: Number(zone.y_min) },
      { x: Number(zone.x_max), y: Number(zone.y_max) },
      { x: Number(zone.x_min), y: Number(zone.y_max) },
    ];
  }

  function pointOnSegment(point, start, end, epsilon = 1e-9) {
    const cross = (point.y - start.y) * (end.x - start.x)
      - (point.x - start.x) * (end.y - start.y);
    if (Math.abs(cross) > epsilon) return false;
    return point.x >= Math.min(start.x, end.x) - epsilon
      && point.x <= Math.max(start.x, end.x) + epsilon
      && point.y >= Math.min(start.y, end.y) - epsilon
      && point.y <= Math.max(start.y, end.y) + epsilon;
  }

  // Ray-casting in world metres. Points on a polygon edge count as inside so
  // a tag exactly on a room boundary does not flicker between zone and null.
  function pointInPolygon(point, polygon) {
    const candidate = Array.isArray(polygon)
      ? polygon.map(value => Array.isArray(value)
        ? { x: Number(value[0]), y: Number(value[1]) }
        : { x: Number(value.x), y: Number(value.y) })
      : pointsFromGeometry(polygon?.geometry || polygon);
    const points = candidate.length >= 3 ? candidate : zonePoints(polygon || {});
    if (points.length < 3 || !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) {
      return false;
    }

    const target = { x: Number(point.x), y: Number(point.y) };
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const a = points[previous];
      const b = points[index];
      if (pointOnSegment(target, a, b)) return true;
      const crosses = (a.y > target.y) !== (b.y > target.y)
        && target.x < ((b.x - a.x) * (target.y - a.y)) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function zoneAtPoint(point, zones = state.zones) {
    return zones.find(zone => pointInPolygon(point, zone)) || null;
  }

  function zoneExtendsOutside(points) {
    const boundary = boundaryPoints();
    return points.some((point, index) => {
      const next = points[(index + 1) % points.length];
      for (let step = 0; step <= 20; step += 1) {
        const ratio = step / 20;
        const sample = { x: point.x + (next.x - point.x) * ratio, y: point.y + (next.y - point.y) * ratio };
        if (!pointInPolygon(sample, boundary)) return true;
      }
      return false;
    });
  }

  function renderZones() {
    clearLayer(ui.zoneLayer);
    const scale = visualScale();
    state.zones.slice().sort((a, b) => Number(a.stack_order || 0) - Number(b.stack_order || 0)).forEach(zone => {
      if (zone.is_visible === false) return;
      const points = zonePoints(zone);
      const group = entityGroup('zone', zone.zone_id);
      group.appendChild(svgElement('polygon', {
        class: 'editor-shape zone-shape',
        points: pointString(points),
        style: `fill:${zone.color || '#4F9DDE'};fill-opacity:${Number.isFinite(Number(zone.opacity)) ? Number(zone.opacity) : 0.3}`,
      }));
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = svgY(points.reduce((sum, point) => sum + point.y, 0) / points.length);
      group.appendChild(svgElement('circle', {
        class: 'entity-label-dot', cx: x, cy: y, r: scale.handle * 0.55,
      }));
      addLabel(group, zone.name, x + scale.offset * 0.75, y - scale.offset * 0.45);
      addVertexHandles(group, 'zone', zone.zone_id, points);
      ui.zoneLayer.appendChild(group);
    });
  }

  function renderAnchors() {
    clearLayer(ui.anchorLayer);
    const scale = visualScale();
    state.anchors.forEach(anchor => {
      const x = Number(anchor.x);
      const y = svgY(Number(anchor.y));
      const size = scale.anchor * 0.55;
      const group = entityGroup('anchor', anchor.anchor_id);
      group.appendChild(svgElement('circle', {
        class: 'anchor-hit', cx: x, cy: y, r: scale.anchor * 1.45,
      }));
      group.appendChild(svgElement('circle', {
        class: 'editor-shape anchor-shape',
        cx: x,
        cy: y,
        r: size,
      }));
      const orientation = Number(anchor.orientation_deg || 0) * Math.PI / 180;
      const arrowLength = scale.anchor * 2.4;
      const arrowX = x + Math.cos(orientation) * arrowLength;
      const arrowY = y - Math.sin(orientation) * arrowLength;
      group.appendChild(svgElement('line', {
        class: 'orientation-arrow', x1: x, y1: y, x2: arrowX, y2: arrowY,
      }));
      group.appendChild(svgElement('circle', {
        class: 'orientation-handle', cx: arrowX, cy: arrowY, r: scale.handle * 0.85,
        'data-kind': 'anchor', 'data-id': anchor.anchor_id, 'data-orientation-handle': 'true',
      }));
      addLabel(group, anchor.anchor_id, x + size + scale.offset * 0.5, y - size);
      ui.anchorLayer.appendChild(group);
    });
  }

  function renderDimensions() {
    clearLayer(ui.dimensionLayer);
    const scale = visualScale();
    state.dimensions.forEach(dimension => {
      const start = { x: Number(dimension.x1), y: Number(dimension.y1) };
      const end = { x: Number(dimension.x2), y: Number(dimension.y2) };
      const group = entityGroup('dimension', dimension.dimension_id);
      group.appendChild(svgElement('line', {
        class: 'editor-shape dimension-shape',
        x1: start.x,
        y1: svgY(start.y),
        x2: end.x,
        y2: svgY(end.y),
      }));
      for (const point of [start, end]) {
        group.appendChild(svgElement('line', {
          class: 'dimension-tick',
          x1: point.x,
          y1: svgY(point.y) - scale.tick,
          x2: point.x,
          y2: svgY(point.y) + scale.tick,
        }));
      }
      const label = dimension.label || `${Number(dimension.length_m).toFixed(2)} m`;
      addLabel(
        group,
        label,
        (start.x + end.x) / 2,
        svgY((start.y + end.y) / 2) - scale.offset,
        'middle',
      );
      ui.dimensionLayer.appendChild(group);
    });
  }

  function renderDraft() {
    clearLayer(ui.draftLayer);
    clearLayer(ui.guideLayer);
    if (state.wallCandidate) {
      ui.guideLayer.appendChild(svgElement('line', {
        class: 'alignment-guide',
        x1: state.wallCandidate.start.x, y1: svgY(state.wallCandidate.start.y),
        x2: state.wallCandidate.end.x, y2: svgY(state.wallCandidate.end.y),
      }));
    }
    if (state.marquee) {
      const x = Math.min(state.marquee.start.x, state.marquee.end.x);
      const y = Math.min(state.marquee.start.y, state.marquee.end.y);
      ui.draftLayer.appendChild(svgElement('rect', {
        class: 'marquee-shape', x, y: svgY(y + Math.abs(state.marquee.end.y - state.marquee.start.y)),
        width: Math.abs(state.marquee.end.x - state.marquee.start.x),
        height: Math.abs(state.marquee.end.y - state.marquee.start.y),
      }));
    }
    if (!state.draft) {
      syncPrecisionInput();
      return;
    }
    const draft = state.draft;
    const scale = visualScale();

    if (['zone', 'boundary'].includes(draft.kind)) {
      const points = draft.cursor ? [...draft.points, draft.cursor] : draft.points;
      if (points.length >= 2) {
        ui.draftLayer.appendChild(svgElement('polyline', {
          class: 'draft-shape',
          points: pointString(points),
          fill: 'none',
        }));
      }
      draft.points.forEach(point => {
        ui.draftLayer.appendChild(svgElement('circle', {
          class: 'draft-handle', cx: point.x, cy: svgY(point.y), r: scale.handle,
        }));
      });
      if (draft.cursor && draft.points.length) {
        const start = draft.points[draft.points.length - 1];
        const { length } = measurement(start, draft.cursor);
        const label = svgElement('text', {
          class: 'edge-length-label',
          x: (start.x + draft.cursor.x) / 2,
          y: svgY((start.y + draft.cursor.y) / 2) - scale.offset * 0.5,
          'text-anchor': 'middle',
        });
        label.textContent = `${length.toFixed(3)} m`;
        ui.draftLayer.appendChild(label);
        const alignment = findAlignmentGuides(draft.cursor, [...boundaryPoints(), ...state.zones.flatMap(zonePoints)]);
        alignment.forEach(guide => ui.guideLayer.appendChild(svgElement('line', {
          class: 'alignment-guide', ...guide,
        })));
      }
      syncPrecisionInput();
      return;
    }

    if (!draft.start || !draft.end) {
      syncPrecisionInput();
      return;
    }
    const x = Math.min(draft.start.x, draft.end.x);
    const y = Math.min(draft.start.y, draft.end.y);
    const width = Math.abs(draft.end.x - draft.start.x);
    const height = Math.abs(draft.end.y - draft.start.y);
    if (draft.kind === 'rectangle') {
      ui.draftLayer.appendChild(svgElement('rect', {
        class: 'draft-shape', x, y: svgY(y + height), width, height,
      }));
    } else {
      ui.draftLayer.appendChild(svgElement('line', {
        class: 'draft-shape',
        x1: draft.start.x,
        y1: svgY(draft.start.y),
        x2: draft.end.x,
        y2: svgY(draft.end.y),
      }));
      if (draft.kind === 'dimension') {
        const { length } = measurement(draft.start, draft.end);
        addLabel(
          ui.draftLayer,
          `${length.toFixed(2)} m`,
          (draft.start.x + draft.end.x) / 2,
          svgY((draft.start.y + draft.end.y) / 2) - scale.offset,
          'middle',
        );
      }
    }
    syncPrecisionInput();
  }

  function findAlignmentGuides(point, candidates) {
    const tolerance = metresPerPixel() * 7;
    const extent = Math.max(widthMetres(), heightMetres()) * 2;
    const guides = [];
    const xMatch = candidates.find(candidate => Math.abs(candidate.x - point.x) <= tolerance);
    const yMatch = candidates.find(candidate => Math.abs(candidate.y - point.y) <= tolerance);
    if (xMatch) guides.push({ x1: xMatch.x, y1: -extent, x2: xMatch.x, y2: extent });
    if (yMatch) guides.push({ x1: -extent, y1: svgY(yMatch.y), x2: extent, y2: svgY(yMatch.y) });
    return guides;
  }

  function snapToAlignments(point) {
    if (!state.snapEnabled) return point;
    const candidates = [...boundaryPoints(), ...state.zones.flatMap(zonePoints), ...(state.draft?.points || [])];
    const tolerance = metresPerPixel() * 7;
    const xMatch = candidates.find(candidate => Math.abs(candidate.x - point.x) <= tolerance);
    const yMatch = candidates.find(candidate => Math.abs(candidate.y - point.y) <= tolerance);
    return { x: xMatch ? xMatch.x : point.x, y: yMatch ? yMatch.y : point.y };
  }

  function renderScene() {
    if (!state.plan) return;
    renderBoundary();
    renderZones();
    renderObjects();
    renderDimensions();
    renderAnchors();
    renderDraft();
    updateInspector();
  }

  function updateGrid() {
    const step = state.gridStep;
    const major = step * 5;
    ui.minorPattern.setAttribute('width', step);
    ui.minorPattern.setAttribute('height', step);
    ui.minorPath.setAttribute('d', `M ${step} 0 L 0 0 0 ${step}`);
    ui.majorPattern.setAttribute('width', major);
    ui.majorPattern.setAttribute('height', major);
    ui.majorPath.setAttribute('d', `M ${major} 0 L 0 0 0 ${major}`);

    for (const fill of [ui.background, ui.minorGrid, ui.majorGrid]) {
      fill.setAttribute('x', state.view.x);
      fill.setAttribute('y', state.view.y);
      fill.setAttribute('width', state.view.width);
      fill.setAttribute('height', state.view.height);
    }
    ui.gridLayer.hidden = !state.gridVisible;
  }

  function applyViewBox(rerender = false) {
    const view = state.view;
    ui.svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    updateGrid();
    const percent = Math.round((state.fitWidth / view.width) * 100);
    ui.zoom.textContent = `${percent}%`;
    if (rerender) renderScene();
  }

  function fitView() {
    if (!state.plan) return;
    const bounds = planBounds();
    const planWidth = Math.max(0.01, bounds.width);
    const planHeight = Math.max(0.01, bounds.height);
    const margin = Math.max(0.5, Math.max(planWidth, planHeight) * 0.06);
    let width = planWidth + margin * 2;
    let height = planHeight + margin * 2;
    const rect = canvasRect();
    const canvasAspect = Math.max(0.2, rect.width / Math.max(1, rect.height));
    if (width / height > canvasAspect) height = width / canvasAspect;
    else width = height * canvasAspect;
    state.view = {
      x: (bounds.xMin + bounds.xMax) / 2 - width / 2,
      y: planHeight / 2 - height / 2,
      width,
      height,
    };
    state.fitWidth = width;
    applyViewBox(true);
  }

  function adjustViewToCanvas() {
    if (!state.plan) return;
    const rect = canvasRect();
    if (!rect.width || !rect.height) return;
    const centerY = state.view.y + state.view.height / 2;
    state.view.height = state.view.width / (rect.width / rect.height);
    state.view.y = centerY - state.view.height / 2;
    applyViewBox(true);
  }

  function zoomAt(factor, clientX = null, clientY = null) {
    if (!state.plan) return;
    const rect = canvasRect();
    const xRatio = clientX == null ? 0.5 : (clientX - rect.left) / Math.max(1, rect.width);
    const yRatio = clientY == null ? 0.5 : (clientY - rect.top) / Math.max(1, rect.height);
    const anchorX = state.view.x + xRatio * state.view.width;
    const anchorY = state.view.y + yRatio * state.view.height;
    const minWidth = Math.max(0.05, widthMetres() * 0.015);
    const maxWidth = Math.max(100, widthMetres() * 30);
    const width = Math.min(maxWidth, Math.max(minWidth, state.view.width * factor));
    const height = width / Math.max(0.2, rect.width / Math.max(1, rect.height));
    state.view = {
      x: anchorX - xRatio * width,
      y: anchorY - yRatio * height,
      width,
      height,
    };
    applyViewBox(true);
  }

  function entityBySelection() {
    if (!state.selected) return null;
    const { kind, id } = state.selected;
    if (kind === 'boundary') return state.plan;
    const collection = {
      object: state.objects,
      zone: state.zones,
      anchor: state.anchors,
      dimension: state.dimensions,
    }[kind];
    const key = { object: 'object_id', zone: 'zone_id', anchor: 'anchor_id', dimension: 'dimension_id' }[kind];
    return collection?.find(entity => String(entity[key]) === String(id)) || null;
  }

  function describeSelection(entity) {
    if (!entity || !state.selected) return {};
    const kind = state.selected.kind;
    if (kind === 'boundary') {
      const points = boundaryPoints();
      return { Type: 'Plan boundary', Points: points.length, Area: `${polygonArea(points).toFixed(3)} m²` };
    }
    if (kind === 'anchor') {
      return {
        ID: entity.anchor_id,
        Hardware: entity.hardware_address || '—',
        X: `${Number(entity.x).toFixed(3)} m`,
        Y: `${Number(entity.y).toFixed(3)} m`,
        Z: entity.z == null ? '—' : `${Number(entity.z).toFixed(3)} m`,
        Mount: entity.mount_height_m == null ? '—' : `${Number(entity.mount_height_m).toFixed(3)} m`,
      };
    }
    if (kind === 'dimension') {
      return {
        ID: entity.dimension_id,
        Length: `${Number(entity.length_m).toFixed(3)} m`,
        Angle: `${Number(entity.angle_deg).toFixed(2)}°`,
        Label: entity.label || '—',
      };
    }
    if (kind === 'zone') {
      const points = zonePoints(entity);
      return {
        ID: entity.zone_id,
        Name: entity.name,
        Points: points.length,
        Bounds: `${Number(entity.x_min).toFixed(2)}, ${Number(entity.y_min).toFixed(2)} → ${Number(entity.x_max).toFixed(2)}, ${Number(entity.y_max).toFixed(2)} m`,
        Geometry: JSON.stringify(entity.geometry),
      };
    }
    const points = linePoints(entity);
    if (points.length === 2) {
      const { length, angle } = measurement(points[0], points[1]);
      return {
        ID: entity.object_id,
        Type: entity.object_type,
        Length: `${length.toFixed(3)} m`,
        Angle: `${angle.toFixed(2)}°`,
        Start: `${points[0].x.toFixed(3)}, ${points[0].y.toFixed(3)} m`,
        End: `${points[1].x.toFixed(3)}, ${points[1].y.toFixed(3)} m`,
      };
    }
    return {
      ID: entity.object_id,
      Type: entity.object_type,
      Label: entity.label || '—',
      Geometry: JSON.stringify(entity.geometry),
    };
  }

  function updateInspector() {
    const entity = entityBySelection();
    if (state.plan) {
      const bounds = planBounds();
      ui.planWidthInput.value = compactNumber(bounds.width, 6);
      ui.planHeightInput.value = compactNumber(bounds.height, 6);
      ui.planAreaOutput.value = polygonArea(boundaryPoints()).toFixed(3);
    }
    ui.planSettings.hidden = !state.plan || Boolean(state.selected && state.selected.kind !== 'boundary');
    ui.selectionSummary.textContent = entity
      ? (state.selections.length > 1
        ? `${state.selections.length} objects`
        : `${state.selected.kind[0].toUpperCase()}${state.selected.kind.slice(1)}`)
      : 'ยังไม่ได้เลือกวัตถุ';
    ui.selectionDetails.replaceChildren();
    for (const [label, value] of Object.entries(describeSelection(entity))) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = String(value);
      row.append(term, detail);
      ui.selectionDetails.appendChild(row);
    }
    const values = [state.objects.length, state.zones.length, state.anchors.length, state.dimensions.length];
    ui.counts.querySelectorAll('b').forEach((element, index) => {
      element.textContent = String(values[index] || 0);
    });
    updateAnchorSettings(entity);
    updateLineSettings(entity);
    updateZoneSettings(entity);
    updateVertexSettings();
    renderZoneList();
    renderPlanVertexTable();
    const copyable = state.selections.some(selection => ['zone', 'anchor'].includes(selection.kind));
    document.getElementById('tool-copy').disabled = !copyable;
    document.getElementById('tool-duplicate').disabled = !state.canEdit || !copyable;
  }

  function hasPersistedPlan() {
    return Boolean(state.plan?.plan_id && !state.isNewPlan);
  }

  function populatePlanForm() {
    if (!state.plan) return;
    ui.planInput.value = state.plan.plan_id || '';
    ui.planNameInput.value = state.plan.name || '';
    ui.planWidthInput.value = String(Number(state.plan.width_m) || 20);
    ui.planHeightInput.value = String(Number(state.plan.height_m) || 20);
    ui.planCeilingInput.value = String(Number(state.plan.ceiling_height_m) || 3);
    ui.planAreaOutput.value = polygonArea(boundaryPoints()).toFixed(3);
    ui.planVersionInput.value = String(Number(state.plan.version) || 1);
    ui.planActiveInput.checked = Boolean(state.plan.is_active);
  }

  function updatePlanControls() {
    const hasProject = Boolean(ui.projectSelect.value);
    const persisted = hasPersistedPlan();
    const formEditable = state.isAdmin && state.editMode && Boolean(state.plan) && !state.busy;
    state.canEdit = formEditable && persisted;

    ui.projectSelect.disabled = state.busy || state.isNewPlan;
    ui.planSelect.disabled = state.busy || state.isNewPlan || !hasProject;
    ui.newPlan.disabled = state.busy || !state.isAdmin || !hasProject;
    ui.editPlan.disabled = state.busy || !state.isAdmin || !persisted || state.editMode;
    ui.savePlan.disabled = state.busy || !formEditable;
    ui.editPlan.classList.toggle('is-active', state.editMode && persisted);

    ui.planInput.disabled = !formEditable;
    ui.planInput.readOnly = !state.isNewPlan;
    ui.planNameInput.disabled = !formEditable;
    ui.planWidthInput.disabled = true;
    ui.planHeightInput.disabled = true;
    ui.planCeilingInput.disabled = !formEditable;
    ui.planVersionInput.disabled = !formEditable;
    ui.planActiveInput.disabled = !formEditable;
    ui.drawBoundary.disabled = !formEditable;
    document.getElementById('tool-copy').disabled = !state.selections.some(selection => ['zone', 'anchor'].includes(selection.kind));
    document.getElementById('tool-duplicate').disabled = !state.canEdit || !state.selections.some(selection => ['zone', 'anchor'].includes(selection.kind));
    const canRegisterHardware = Boolean(state.isAdmin && state.plan?.plan_id && !state.isNewPlan);
    ui.gatewayDeviceInput.disabled = !canRegisterHardware;
    ui.hardwareTagInput.disabled = !canRegisterHardware;
    ui.registerHardware.disabled = !canRegisterHardware;

    document.querySelectorAll('[data-tool]').forEach(button => {
      if (EDIT_TOOLS.has(button.dataset.tool)) {
        button.disabled = button.dataset.tool === 'boundary' ? !formEditable : !state.canEdit;
      }
    });
    document.getElementById('tool-delete').disabled = !state.canEdit;

    // A short API save makes canEdit false while state.busy is true. Keep the
    // current drawing command alive so polyline entry can continue afterwards.
    if (!state.canEdit && !state.busy && EDIT_TOOLS.has(state.tool)
        && !(state.isNewPlan && state.tool === 'boundary')) setTool('select');
    if (!state.isAdmin) {
      ui.roleHint.textContent = `Read only · role ${session.user?.role || '-'} ไม่มีสิทธิ์แก้ไขแปลน`;
    } else if (state.isNewPlan) {
      ui.roleHint.textContent = 'Admin · กรอกข้อมูลแล้วกดบันทึกก่อนเริ่มวาดแปลน';
    } else if (state.editMode) {
      ui.roleHint.textContent = 'Admin · โหมดแก้ไข การวาดและแก้ไขวัตถุจะบันทึกลงฐานข้อมูลทันที';
    } else {
      ui.roleHint.textContent = 'Admin · กดแก้ไขเพื่อเปลี่ยนข้อมูลหรือวาดบนแปลน';
    }
    ui.roleHint.classList.toggle('can-edit', state.isAdmin);
    updateHistoryButtons();
  }

  function updateAnchorSettings(entity) {
    const selectedAnchor = state.selected?.kind === 'anchor' && state.selections.length === 1 ? entity : null;
    const placingAnchor = state.tool === 'anchor' && !selectedAnchor;
    ui.anchorSettings.hidden = !selectedAnchor && !placingAnchor;
    if (ui.anchorSettings.hidden) return;

    ui.anchorSettingsTitle.textContent = selectedAnchor ? 'Anchor properties' : 'Anchor placement defaults';
    ui.anchorIdInput.disabled = Boolean(selectedAnchor);
    ui.anchorIdInput.placeholder = `Auto: ${nextAnchorId()}`;
    ui.saveAnchorProperties.hidden = !selectedAnchor || !state.canEdit;

    if (!ui.anchorSettings.contains(document.activeElement)) {
      ui.anchorIdInput.value = selectedAnchor?.anchor_id || '';
      ui.anchorHardwareInput.value = selectedAnchor?.hardware_address || '';
      ui.anchorZInput.value = selectedAnchor?.z == null ? '' : String(selectedAnchor.z);
      ui.anchorMountInput.value = selectedAnchor?.mount_height_m == null
        ? '' : String(selectedAnchor.mount_height_m);
      ui.anchorMountTypeInput.value = selectedAnchor?.mount_type || ui.anchorMountTypeInput.value || 'free';
      ui.anchorOrientationInput.value = String(selectedAnchor?.orientation_deg ?? ui.anchorOrientationInput.value ?? 0);
      ui.anchorGatewayInput.value = selectedAnchor?.gateway_device_id || '';
      ui.anchorTagInput.value = selectedAnchor?.bound_tag_id || '';
      const wallRef = selectedAnchor?.wall_ref;
      ui.anchorWallRefField.hidden = (selectedAnchor?.mount_type || ui.anchorMountTypeInput.value) !== 'wall';
      ui.anchorWallRefOutput.value = wallRef
        ? `${wallRef.source || 'boundary'} edge ${Number(wallRef.edgeIndex ?? 0) + 1} · ${(Number(wallRef.offsetRatio || 0) * 100).toFixed(1)}%${wallRef.needsReview ? ' · review required' : ''}`
        : 'Choose a wall on canvas';
      ui.anchorFacingInput.value = wallRef?.facingSide || 'inside';
    }
  }

  function updateLineSettings(entity) {
    const points = state.selected?.kind === 'object' ? linePoints(entity) : [];
    ui.lineSettings.hidden = points.length !== 2;
    if (ui.lineSettings.hidden) return;

    const { length, angle } = measurement(points[0], points[1]);
    ui.lineLengthInput.disabled = !state.canEdit;
    ui.lineAngleInput.disabled = !state.canEdit;
    ui.saveLineProperties.hidden = !state.canEdit;
    if (!ui.lineSettings.contains(document.activeElement)) {
      ui.lineLengthInput.value = length.toFixed(6).replace(/\.?0+$/, '');
      ui.lineAngleInput.value = angle.toFixed(6).replace(/\.?0+$/, '');
    }
  }

  function updateZoneSettings(entity) {
    const zone = state.selected?.kind === 'zone' && state.selections.length === 1 ? entity : null;
    ui.zoneSettings.hidden = !zone;
    if (!zone || ui.zoneSettings.contains(document.activeElement)) return;
    const points = zonePoints(zone);
    ui.zoneNameInput.value = zone.name || '';
    ui.zoneTypeInput.value = zone.zone_type || 'general';
    ui.zoneColorInput.value = /^#[0-9a-f]{6}$/i.test(zone.color || '') ? zone.color : '#4F9DDE';
    ui.zoneOpacityInput.value = String(zone.opacity ?? 0.3);
    ui.zoneAreaOutput.textContent = `${polygonArea(points).toFixed(3)} m²`;
    const inside = state.anchors.filter(anchor => pointInPolygon({ x: anchor.x, y: anchor.y }, points));
    ui.zoneAnchorsOutput.textContent = inside.map(anchor => anchor.anchor_id).join(', ') || '—';
  }

  function editablePoints(kind, id) {
    if (kind === 'boundary') return boundaryPoints();
    if (kind === 'zone') {
      const zone = state.zones.find(item => String(item.zone_id) === String(id));
      return zone ? zonePoints(zone) : [];
    }
    return [];
  }

  function updateVertexSettings() {
    const vertex = state.selectedVertex;
    ui.vertexSettings.hidden = !vertex;
    if (!vertex) return;
    const point = editablePoints(vertex.kind, vertex.id)[vertex.index];
    if (!point || ui.vertexSettings.contains(document.activeElement)) return;
    ui.vertexXInput.value = compactNumber(point.x, 6);
    ui.vertexYInput.value = compactNumber(point.y, 6);
  }

  function renderPlanVertexTable() {
    ui.planVertexTable.replaceChildren();
    if (!state.plan) return;
    boundaryPoints().forEach((point, index) => {
      const row = document.createElement('div');
      row.className = 'vertex-row';
      row.innerHTML = `<span>${index + 1}</span><input type="number" step="0.001"><input type="number" step="0.001"><button type="button" title="Remove vertex">×</button>`;
      const [xInput, yInput] = row.querySelectorAll('input');
      xInput.value = compactNumber(point.x, 6);
      yInput.value = compactNumber(point.y, 6);
      const apply = () => void updateVertex('boundary', state.plan.plan_id || 'draft-plan', index, {
        x: Number(xInput.value), y: Number(yInput.value),
      });
      xInput.addEventListener('change', apply);
      yInput.addEventListener('change', apply);
      row.querySelector('button').addEventListener('click', () => void removeVertex('boundary', state.plan.plan_id || 'draft-plan', index));
      ui.planVertexTable.appendChild(row);
    });
  }

  function renderZoneList() {
    ui.zoneList.replaceChildren();
    if (!state.zones.length) {
      const empty = document.createElement('div');
      empty.className = 'zone-list-empty';
      empty.textContent = 'No zones';
      ui.zoneList.appendChild(empty);
      return;
    }
    state.zones.slice().sort((a, b) => Number(b.stack_order || 0) - Number(a.stack_order || 0)).forEach(zone => {
      const row = document.createElement('div');
      row.className = `zone-list-item${isSelected('zone', zone.zone_id) ? ' is-selected' : ''}`;
      row.innerHTML = `<button type="button" data-visibility title="Show / hide">${zone.is_visible === false ? '○' : '●'}</button><span class="zone-swatch"></span><button type="button" class="zone-name"></button><span class="zone-order-actions"><button type="button" data-front title="Bring forward">↑</button><button type="button" data-back title="Send backward">↓</button></span>`;
      row.querySelector('.zone-swatch').style.background = zone.color || '#4F9DDE';
      row.querySelector('.zone-name').textContent = zone.name;
      row.querySelector('.zone-name').addEventListener('click', () => selectEntity('zone', zone.zone_id));
      row.querySelector('[data-visibility]').addEventListener('click', () => void updateZone(zone, { is_visible: zone.is_visible === false }));
      row.querySelector('[data-front]').addEventListener('click', () => void reorderZone(zone, 1));
      row.querySelector('[data-back]').addEventListener('click', () => void reorderZone(zone, -1));
      ui.zoneList.appendChild(row);
    });
  }

  function selectEntity(kind, id) {
    state.selections = kind ? [{ kind, id }] : [];
    state.selectedVertex = null;
    syncPrimarySelection();
    renderScene();
  }

  function toggleEntitySelection(kind, id) {
    const key = `${kind}:${id}`;
    const index = state.selections.findIndex(selection => selectionKey(selection) === key);
    if (index >= 0) state.selections.splice(index, 1);
    else state.selections.push({ kind, id });
    state.selectedVertex = null;
    syncPrimarySelection();
    renderScene();
  }

  function setTool(tool) {
    const canUseBoundaryDraft = tool === 'boundary' && state.isAdmin && state.editMode && Boolean(state.plan);
    if (EDIT_TOOLS.has(tool) && !state.canEdit && !canUseBoundaryDraft) {
      setMessage('โหมดวาดต้องใช้สิทธิ์ admin', 'error');
      return;
    }
    state.tool = tool;
    if (tool === 'anchor') {
      state.selections = [];
      syncPrimarySelection();
    }
    state.draft = ['zone', 'boundary'].includes(tool) ? { kind: tool, points: [], cursor: null } : null;
    document.querySelectorAll('[data-tool]').forEach(button => {
      const active = button.dataset.tool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    ui.svg.dataset.tool = tool;
    const help = {
      select: 'Select: คลิกวัตถุเพื่อเลือก · ลาก object เพื่อย้าย',
      line: 'Line: click a start point, then click an end point or enter exact Length / Angle · Esc to finish',
      boundary: 'Plan boundary: click vertices, then click the first point / Enter / double-click to close',
      rectangle: 'Rectangle: ลากมุมตรงข้ามสองมุม',
      zone: 'Zone: click points or enter exact edge lengths · click the first point / double-click to close',
      anchor: 'Anchor: ตั้งค่า ID / Z / Mount height แล้วคลิกตำแหน่งติดตั้ง',
      dimension: 'Dimension: คลิกจุดเริ่ม แล้วคลิกจุดปลาย',
    };
    setMessage(help[tool] || '');
    renderScene();
  }

  async function safeMutation(action, successMessage) {
    if (state.busy) return null;
    state.busy = true;
    updatePlanControls();
    try {
      const result = await action();
      if (successMessage) setMessage(successMessage, 'ok');
      return result;
    } catch (error) {
      setMessage(error?.message || 'บันทึกข้อมูลไม่สำเร็จ', 'error');
      return null;
    } finally {
      state.busy = false;
      updatePlanControls();
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function updateHistoryButtons() {
    document.getElementById('tool-undo').disabled = !state.canEdit || !state.undoStack.length || state.busy;
    document.getElementById('tool-redo').disabled = !state.canEdit || !state.redoStack.length || state.busy;
  }

  function recordCommand(label, undo, redo) {
    state.undoStack.push({ label, undo, redo });
    if (state.undoStack.length > 100) state.undoStack.shift();
    state.redoStack = [];
    updateHistoryButtons();
  }

  async function undo() {
    if (!state.canEdit || state.busy || !state.undoStack.length) return;
    const command = state.undoStack.pop();
    const ok = await command.undo();
    if (ok !== false) {
      state.redoStack.push(command);
      setMessage(`Undo: ${command.label}`, 'ok');
    } else state.undoStack.push(command);
    updateHistoryButtons();
  }

  async function redo() {
    if (!state.canEdit || state.busy || !state.redoStack.length) return;
    const command = state.redoStack.pop();
    const ok = await command.redo();
    if (ok !== false) {
      state.undoStack.push(command);
      setMessage(`Redo: ${command.label}`, 'ok');
    } else state.redoStack.push(command);
    updateHistoryButtons();
  }

  function collectionForKind(kind) {
    return { object: state.objects, zone: state.zones, anchor: state.anchors, dimension: state.dimensions }[kind];
  }

  function idKeyForKind(kind) {
    return { object: 'object_id', zone: 'zone_id', anchor: 'anchor_id', dimension: 'dimension_id' }[kind];
  }

  function payloadForEntity(kind, entity) {
    if (kind === 'object') return {
      object_type: entity.object_type, label: entity.label || null,
      geometry: entity.geometry, properties: entity.properties || {},
    };
    if (kind === 'zone') return {
      name: entity.name, geometry: entity.geometry, zone_type: entity.zone_type || 'general',
      color: entity.color || '#4F9DDE', opacity: Number(entity.opacity ?? 0.3),
      is_visible: entity.is_visible !== false, stack_order: Number(entity.stack_order || 0),
    };
    if (kind === 'anchor') return {
      anchor_id: entity.anchor_id, hardware_address: entity.hardware_address || null,
      x: Number(entity.x), y: Number(entity.y), z: Number(entity.z || 0),
      mount_height_m: Number(entity.z || entity.mount_height_m || 0), mount_type: entity.mount_type || 'free',
      orientation_deg: Number(entity.orientation_deg || 0), wall_ref: entity.wall_ref || null,
      gateway_device_id: entity.gateway_device_id || null, bound_tag_id: entity.bound_tag_id || null,
      battery: entity.battery ?? null,
    };
    return {
      x1: Number(entity.x1), y1: Number(entity.y1), x2: Number(entity.x2), y2: Number(entity.y2),
      length_m: Number(entity.length_m), angle_deg: Number(entity.angle_deg || 0), label: entity.label || null,
    };
  }

  async function createEntityRemote(kind, payload) {
    const plural = { object: 'objects', zone: 'zones', anchor: 'anchors', dimension: 'dimensions' }[kind];
    const response = await safeMutation(() => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/${plural}`, {
      method: 'POST', body: JSON.stringify(payload),
    }));
    return response?.[kind] || response?.object || null;
  }

  async function deleteEntityRemote(kind, entity) {
    const plural = { object: 'objects', zone: 'zones', anchor: 'anchors', dimension: 'dimensions' }[kind];
    const id = entity[idKeyForKind(kind)];
    const response = await safeMutation(() => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/${plural}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }));
    return Boolean(response?.ok);
  }

  function removeLocalEntity(kind, entity) {
    const collection = collectionForKind(kind);
    const key = idKeyForKind(kind);
    const index = collection.findIndex(item => String(item[key]) === String(entity[key]));
    if (index >= 0) collection.splice(index, 1);
  }

  function addLocalEntity(kind, entity) {
    collectionForKind(kind).push(entity);
  }

  function replaceAnchorRows(rows) {
    const existing = new Map(state.anchors.map(anchor => [String(anchor.anchor_id), anchor]));
    state.anchors = rows.map(row => {
      const anchor = existing.get(String(row.anchor_id));
      if (anchor) {
        Object.assign(anchor, row);
        return anchor;
      }
      return row;
    });
  }

  function recordCreation(kind, created, payload, label) {
    let entity = created;
    recordCommand(label, async () => {
      if (!await deleteEntityRemote(kind, entity)) return false;
      removeLocalEntity(kind, entity);
      state.selections = [];
      syncPrimarySelection();
      renderScene();
      return true;
    }, async () => {
      const recreated = await createEntityRemote(kind, payload);
      if (!recreated) return false;
      entity = recreated;
      addLocalEntity(kind, entity);
      renderScene();
      return true;
    });
  }

  async function createObject(kind, start, end) {
    let geometry;
    let properties = {};
    if (kind === 'rectangle') {
      geometry = {
        type: 'rectangle',
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
    } else {
      geometry = geometryFromPoints('line', [start, end]);
      const { length, angle } = measurement(start, end);
      properties = { length_m: length, angle_deg: angle };
    }
    const payload = { object_type: kind, geometry, properties };
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      `${kind} บันทึกแล้ว`,
    );
    if (response?.object) {
      state.objects.push(response.object);
      recordCreation('object', response.object, payload, `create ${kind}`);
      if (kind === 'line' && state.tool === 'line') {
        state.draft = { kind: 'line', start: end, end };
      }
      selectEntity('object', response.object.object_id);
      if (kind === 'line' && state.tool === 'line') focusPrecisionLength();
    }
  }

  function nextZoneName() {
    const names = new Set(state.zones.map(zone => String(zone.name).toLowerCase()));
    let number = 1;
    while (names.has(`zone ${number}`)) number += 1;
    return `Zone ${number}`;
  }

  function requestZoneName(defaultName) {
    return new Promise(resolve => {
      state.zoneNameOpen = true;
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-back';
      backdrop.innerHTML = `
        <form class="modal zone-name-modal">
          <div class="modal-head">
            <span class="modal-title">กำหนดชื่อ Zone</span>
            <button class="x" type="button" data-close aria-label="ปิด">&times;</button>
          </div>
          <div class="modal-body">
            <div class="field">
              <label class="label">Zone name</label>
              <input class="control" name="zone-name" maxlength="200" required>
            </div>
            <div class="err" data-error hidden>กรุณาระบุชื่อ Zone</div>
          </div>
          <div class="modal-foot">
            <button class="btn" type="button" data-close>ยกเลิก</button>
            <button class="btn btn-primary" type="submit">บันทึก Zone</button>
          </div>
        </form>`;
      document.body.appendChild(backdrop);
      const form = backdrop.querySelector('form');
      const input = backdrop.querySelector('[name="zone-name"]');
      const error = backdrop.querySelector('[data-error]');
      input.value = defaultName;
      input.select();

      const close = value => {
        state.zoneNameOpen = false;
        backdrop.remove();
        resolve(value);
      };
      backdrop.querySelectorAll('[data-close]').forEach(button => {
        button.addEventListener('click', () => close(null));
      });
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) close(null);
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) {
          error.hidden = false;
          input.focus();
          return;
        }
        close(name);
      });
      form.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(null);
        }
      });
    });
  }

  async function createZone(points, name) {
    const payload = {
      name, geometry: geometryFromPoints('polygon', points), zone_type: 'general',
      color: '#4F9DDE', opacity: 0.3, is_visible: true,
    };
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/zones`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      `${name} บันทึกแล้ว`,
    );
    if (response?.zone) {
      state.zones.push(response.zone);
      recordCreation('zone', response.zone, payload, `create ${name}`);
      selectEntity('zone', response.zone.zone_id);
      if (zoneExtendsOutside(points)) setMessage(`${name} extends outside the plan boundary`, 'error');
    }
  }

  function nextAnchorId() {
    const numbers = state.anchors
      .map(anchor => /^A(\d+)$/i.exec(String(anchor.anchor_id)))
      .filter(Boolean)
      .map(match => Number(match[1]));
    const number = Math.max(0, ...numbers) + 1;
    return `A${number}`;
  }

  function optionalMetres(input, label, minimum = null) {
    const text = input.value.trim();
    if (!text) return null;
    const value = Number(text);
    if (!Number.isFinite(value) || (minimum !== null && value < minimum)) {
      throw new Error(`${label} ต้องเป็นตัวเลข${minimum === null ? '' : `ตั้งแต่ ${minimum}`} เมตร`);
    }
    return value;
  }

  async function createAnchor(point) {
    let anchorId;
    let hardwareAddress;
    let z;
    let mountHeight;
    try {
      anchorId = ui.anchorIdInput.value.trim() || nextAnchorId();
      hardwareAddress = ui.anchorHardwareInput.value.trim() || null;
      z = optionalMetres(ui.anchorZInput, 'Z');
      mountHeight = optionalMetres(ui.anchorMountInput, 'Mount height', 0);
    } catch (error) {
      setMessage(error.message, 'error');
      return;
    }
    if (state.anchors.some(anchor => String(anchor.anchor_id).toLowerCase() === anchorId.toLowerCase())) {
      setMessage(`Anchor ${anchorId} มีอยู่แล้ว`, 'error');
      return;
    }
    const placement = anchorPlacement(point, ui.anchorMountTypeInput.value);
    if (!placement) return;
    const payload = {
      anchor_id: anchorId,
      hardware_address: hardwareAddress,
      x: placement.point.x,
      y: placement.point.y,
      z: z ?? (ui.anchorMountTypeInput.value === 'ceiling' ? Number(state.plan.ceiling_height_m || 3) : 0),
      mount_height_m: mountHeight,
      mount_type: ui.anchorMountTypeInput.value || 'free',
      orientation_deg: ui.anchorOrientationInput.value.trim()
        ? Number(ui.anchorOrientationInput.value)
        : Number(placement.orientationDeg || 0),
      wall_ref: placement.wallRef,
      gateway_device_id: ui.anchorGatewayInput.value.trim() || null,
      bound_tag_id: ui.anchorTagInput.value.trim() || null,
    };
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/anchors`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      `${anchorId} บันทึกแล้ว`,
    );
    if (response?.anchor) {
      state.anchors.push(response.anchor);
      recordCreation('anchor', response.anchor, payload, `create ${anchorId}`);
      ui.anchorIdInput.value = '';
      ui.anchorHardwareInput.value = '';
      selectEntity('anchor', response.anchor.anchor_id);
    }
  }

  async function saveAnchorProperties() {
    const anchor = entityBySelection();
    if (!anchor || state.selected?.kind !== 'anchor') return;
    const before = clone(anchor);
    let z;
    let mountHeight;
    const hardwareAddress = ui.anchorHardwareInput.value.trim() || null;
    try {
      z = optionalMetres(ui.anchorZInput, 'Z');
      mountHeight = optionalMetres(ui.anchorMountInput, 'Mount height', 0);
    } catch (error) {
      setMessage(error.message, 'error');
      return;
    }
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/anchors`, {
        method: 'POST',
        body: JSON.stringify({
          anchor_id: anchor.anchor_id,
          hardware_address: hardwareAddress,
          x: Number(anchor.x),
          y: Number(anchor.y),
          z,
          mount_height_m: mountHeight,
          mount_type: ui.anchorMountTypeInput.value || 'free',
          orientation_deg: Number(ui.anchorOrientationInput.value || 0),
          wall_ref: ui.anchorMountTypeInput.value === 'wall'
            ? { ...(anchor.wall_ref || {}), facingSide: ui.anchorFacingInput.value || 'inside' }
            : null,
          gateway_device_id: ui.anchorGatewayInput.value.trim() || null,
          bound_tag_id: ui.anchorTagInput.value.trim() || null,
          battery: anchor.battery,
        }),
      }),
      `${anchor.anchor_id} properties บันทึกแล้ว`,
    );
    if (response?.anchor) {
      Object.assign(anchor, response.anchor);
      const after = clone(anchor);
      recordCommand(`${anchor.anchor_id} properties`,
        () => updateAnchor(anchor, before, false),
        () => updateAnchor(anchor, after, false));
      renderScene();
    }
  }

  async function updateAnchor(anchor, values, record = true, label = 'update anchor') {
    const before = clone(anchor);
    const payload = payloadForEntity('anchor', { ...anchor, ...values });
    const response = await safeMutation(() => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/anchors`, {
      method: 'POST', body: JSON.stringify(payload),
    }), record ? `${anchor.anchor_id} saved` : null);
    if (!response?.anchor) return false;
    Object.assign(anchor, response.anchor);
    const after = clone(anchor);
    if (record) recordCommand(label,
      () => updateAnchor(anchor, before, false),
      () => updateAnchor(anchor, after, false));
    renderScene();
    return true;
  }

  async function updateZone(zone, changes, record = true, label = 'update zone') {
    const before = clone(zone);
    const response = await safeMutation(() => api(
      `/api/plans/${encodeURIComponent(state.plan.plan_id)}/zones/${encodeURIComponent(zone.zone_id)}`,
      { method: 'PUT', body: JSON.stringify(changes) },
    ), record ? `${zone.name} saved` : null);
    if (!response?.zone) return false;
    Object.assign(zone, response.zone);
    const after = clone(zone);
    if (record) recordCommand(label,
      () => updateZone(zone, payloadForEntity('zone', before), false),
      () => updateZone(zone, payloadForEntity('zone', after), false));
    renderScene();
    if (zoneExtendsOutside(zonePoints(zone))) setMessage(`${zone.name} extends outside the plan boundary`, 'error');
    return true;
  }

  async function saveZoneProperties() {
    const zone = entityBySelection();
    if (!zone || state.selected?.kind !== 'zone') return;
    const opacity = Number(ui.zoneOpacityInput.value);
    if (!ui.zoneNameInput.value.trim() || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      setMessage('Zone name and opacity (0–1) are required', 'error');
      return;
    }
    await updateZone(zone, {
      name: ui.zoneNameInput.value.trim(),
      zone_type: ui.zoneTypeInput.value.trim() || 'general',
      color: ui.zoneColorInput.value,
      opacity,
    }, true, `update ${zone.name}`);
  }

  async function reorderZone(zone, direction) {
    const orders = state.zones.map(item => Number(item.stack_order || 0));
    const stackOrder = direction > 0 ? Math.max(...orders) + 1 : Math.min(...orders) - 1;
    await updateZone(zone, { stack_order: stackOrder }, true, `reorder ${zone.name}`);
  }

  async function registerHardware() {
    if (!state.isAdmin || !state.plan?.plan_id || state.isNewPlan) return;
    const deviceId = ui.gatewayDeviceInput.value.trim();
    const tagId = ui.hardwareTagInput.value.trim();
    if (!deviceId || !tagId) {
      setMessage('กรุณาระบุ Gateway device ID และ Tag ID', 'error');
      return;
    }
    const projectId = state.plan.project_id;
    const planId = state.plan.plan_id;
    const result = await safeMutation(async () => {
      await api(`/api/projects/${encodeURIComponent(projectId)}/hardware-gateways`, {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, plan_id: planId, enabled: true }),
      });
      return api(`/api/projects/${encodeURIComponent(projectId)}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tag_id: tagId, plan_id: planId }),
      });
    }, `เชื่อม ${deviceId} / ${tagId} กับแปลนแล้ว`);
    if (result?.tag) setMessage(`พร้อมรับข้อมูลจาก ${deviceId} สำหรับ ${tagId}`, 'success');
  }

  async function createDimension(start, end) {
    const { length, angle } = measurement(start, end);
    const payload = {
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      length_m: length, angle_deg: angle,
    };
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/dimensions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      'Dimension บันทึกแล้ว',
    );
    if (response?.dimension) {
      state.dimensions.push(response.dimension);
      recordCreation('dimension', response.dimension, payload, 'create dimension');
      selectEntity('dimension', response.dimension.dimension_id);
    }
  }

  async function applyPrecisionInput() {
    const segment = activeSegment();
    if (!segment || (!state.canEdit && !(segment.kind === 'boundary' && state.isNewPlan)) || state.busy) return;

    const length = Number(ui.precisionLength.value);
    const angle = Number(ui.precisionAngle.value);
    if (!Number.isFinite(length) || length <= 0) {
      setMessage('Length must be greater than 0 metres', 'error');
      ui.precisionLength.focus();
      return;
    }
    if (!Number.isFinite(angle)) {
      setMessage('Angle must be a number in degrees', 'error');
      ui.precisionAngle.focus();
      return;
    }

    const radians = angle * Math.PI / 180;
    const end = {
      x: segment.start.x + length * Math.cos(radians),
      y: segment.start.y + length * Math.sin(radians),
    };

    if (['zone', 'boundary'].includes(segment.kind)) {
      const points = state.draft.points;
      const closeTolerance = metresPerPixel() * 12;
      if (points.length >= 3 && distance(end, points[0]) <= closeTolerance) {
        if (segment.kind === 'boundary') finishBoundary();
        else finishZone();
        return;
      }
      points.push(end);
      state.draft.cursor = end;
      renderDraft();
      setMessage(`Zone edge ${length.toFixed(3)} m at ${angle.toFixed(2)}° added`);
      focusPrecisionLength();
      return;
    }

    state.draft = null;
    renderDraft();
    if (segment.kind === 'dimension') {
      await createDimension(segment.start, end);
    } else {
      await createObject('line', segment.start, end);
    }
  }

  async function saveLineProperties() {
    const object = entityBySelection();
    const points = state.selected?.kind === 'object' ? linePoints(object) : [];
    if (!object || points.length !== 2 || !state.canEdit) return;

    const before = clone(object);
    const length = Number(ui.lineLengthInput.value);
    const angle = Number(ui.lineAngleInput.value);
    if (!Number.isFinite(length) || length <= 0) {
      setMessage('Line Length ต้องมากกว่า 0 เมตร', 'error');
      return;
    }
    if (!Number.isFinite(angle)) {
      setMessage('Line Angle ต้องเป็นตัวเลขหน่วย degree', 'error');
      return;
    }

    const radians = angle * Math.PI / 180;
    const start = points[0];
    const end = {
      x: start.x + length * Math.cos(radians),
      y: start.y + length * Math.sin(radians),
    };
    const geometry = geometryFromPoints('line', [start, end]);
    const properties = { ...(object.properties || {}), length_m: length, angle_deg: angle };
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects/${encodeURIComponent(object.object_id)}`, {
        method: 'PUT',
        body: JSON.stringify({ geometry, properties }),
      }),
      'Line properties บันทึกแล้ว',
    );
    if (response?.object) {
      Object.assign(object, response.object);
      const after = clone(object);
      recordCommand('update line properties',
        () => updateObjectData(object, { geometry: before.geometry, properties: before.properties }, false),
        () => updateObjectData(object, { geometry: after.geometry, properties: after.properties }, false));
    }
    renderScene();
  }

  async function updateObjectData(object, values, record = false) {
    const before = clone(object);
    const response = await safeMutation(() => api(
      `/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects/${encodeURIComponent(object.object_id)}`,
      { method: 'PUT', body: JSON.stringify(values) },
    ));
    if (!response?.object) return false;
    Object.assign(object, response.object);
    if (record) {
      const after = clone(object);
      recordCommand('update object',
        () => updateObjectData(object, { geometry: before.geometry, properties: before.properties }, false),
        () => updateObjectData(object, { geometry: after.geometry, properties: after.properties }, false));
    }
    renderScene();
    return true;
  }

  function translatedGeometry(geometry, dx, dy) {
    const translated = JSON.parse(JSON.stringify(geometry || {}));
    if (Array.isArray(translated.points)) {
      translated.points = translated.points.map(point => [Number(point[0]) + dx, Number(point[1]) + dy]);
    }
    if (Number.isFinite(Number(translated.x))) translated.x = Number(translated.x) + dx;
    if (Number.isFinite(Number(translated.y))) translated.y = Number(translated.y) + dy;
    if (Array.isArray(translated.origin) && translated.origin.length >= 2) {
      translated.origin = [Number(translated.origin[0]) + dx, Number(translated.origin[1]) + dy];
    }
    return translated;
  }

  async function saveObjectDrag(drag) {
    const object = state.objects.find(item => String(item.object_id) === String(drag.id));
    if (!object) return;
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects/${encodeURIComponent(drag.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ geometry: object.geometry }),
      }),
      'ย้าย object แล้ว',
    );
    if (response?.object) {
      Object.assign(object, response.object);
    } else {
      object.geometry = drag.originalGeometry;
    }
    renderScene();
  }

  async function deleteSelection() {
    if (state.canEdit && state.selectedVertex) {
      const { kind, id, index } = state.selectedVertex;
      await removeVertex(kind, id, index);
      return;
    }
    const deletable = state.canEdit
      ? state.selections.filter(selection => ['object', 'zone', 'anchor', 'dimension'].includes(selection.kind))
      : [];
    if (deletable.length) {
      const removed = [];
      for (const selection of deletable) {
        const entity = entityForRef(selection);
        if (!entity) continue;
        const saved = { kind: selection.kind, entity, payload: payloadForEntity(selection.kind, entity) };
        if (await deleteEntityRemote(selection.kind, entity)) {
          removeLocalEntity(selection.kind, entity);
          removed.push(saved);
        }
      }
      state.selections = [];
      syncPrimarySelection();
      renderScene();
      if (removed.length) recordCommand(`delete ${removed.length} item${removed.length === 1 ? '' : 's'}`, async () => {
        for (const item of removed) {
          const entity = await createEntityRemote(item.kind, item.payload);
          if (!entity) return false;
          item.entity = entity;
          addLocalEntity(item.kind, entity);
        }
        renderScene();
        return true;
      }, async () => {
        for (const item of removed) {
          if (!await deleteEntityRemote(item.kind, item.entity)) return false;
          removeLocalEntity(item.kind, item.entity);
        }
        renderScene();
        return true;
      });
      return;
    }
    if (!state.canEdit) return setMessage('Delete ต้องใช้สิทธิ์ admin', 'error');
    if (!state.selected) return setMessage('เลือก object ที่ต้องการลบก่อน', 'error');
    if (state.selected.kind !== 'object') {
      return setMessage('Phase นี้รองรับ Delete สำหรับ plan object เท่านั้น', 'error');
    }
    const id = state.selected.id;
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
      'ลบ object แล้ว',
    );
    if (response?.ok) {
      state.objects = state.objects.filter(object => String(object.object_id) !== String(id));
      state.selected = null;
      renderScene();
    }
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function copySelection() {
    state.clipboard = state.selections
      .filter(selection => ['zone', 'anchor'].includes(selection.kind))
      .map(selection => {
        const entity = entityForRef(selection);
        return entity ? { kind: selection.kind, payload: clone(payloadForEntity(selection.kind, entity)) } : null;
      })
      .filter(Boolean);
    setMessage(state.clipboard.length ? `Copied ${state.clipboard.length} item(s)` : 'Select Zones or Anchors to copy');
  }

  async function pasteClipboard() {
    if (!state.canEdit || !state.clipboard.length) return;
    const createdRefs = [];
    for (const item of state.clipboard) {
      const payload = clone(item.payload);
      if (item.kind === 'zone') {
        payload.name = uniqueZoneCopyName(payload.name);
        payload.geometry = translatedGeometry(payload.geometry, state.gridStep, state.gridStep);
        payload.stack_order = Math.max(0, ...state.zones.map(zone => Number(zone.stack_order || 0))) + 1;
      } else {
        payload.anchor_id = nextAnchorId();
        payload.x = Number(payload.x) + state.gridStep;
        payload.y = Number(payload.y) + state.gridStep;
        payload.hardware_address = null;
      }
      const entity = await createEntityRemote(item.kind, payload);
      if (!entity) continue;
      addLocalEntity(item.kind, entity);
      createdRefs.push({ kind: item.kind, id: entity[idKeyForKind(item.kind)] });
      recordCreation(item.kind, entity, payload, `duplicate ${item.kind}`);
    }
    state.selections = createdRefs;
    syncPrimarySelection();
    renderScene();
  }

  function uniqueZoneCopyName(name) {
    const names = new Set(state.zones.map(zone => String(zone.name).toLowerCase()));
    let candidate = `${name} copy`, number = 2;
    while (names.has(candidate.toLowerCase())) candidate = `${name} copy ${number++}`;
    return candidate;
  }

  function duplicateSelection() {
    copySelection();
    return pasteClipboard();
  }

  function nearestPointOnSegment(point, start, end) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 1e-12) return { point: { ...start }, ratio: 0, distance: distance(point, start) };
    const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    const projected = { x: start.x + ratio * dx, y: start.y + ratio * dy };
    return { point: projected, ratio, distance: distance(point, projected) };
  }

  function wallEdges() {
    const edges = [];
    const addEdges = (points, source, objectId = null, closed = true) => {
      const count = closed ? points.length : points.length - 1;
      for (let index = 0; index < count; index += 1) {
        edges.push({ source, objectId, edgeIndex: index, start: points[index], end: points[(index + 1) % points.length] });
      }
    };
    addEdges(boundaryPoints(), 'boundary');
    state.objects.forEach(object => {
      const geometry = object.geometry || {};
      const type = String(geometry.type || object.object_type || '').toLowerCase();
      const points = pointsFromGeometry(geometry);
      if (points.length >= 2) addEdges(points, 'object', object.object_id, type === 'polygon');
      else if (type === 'rectangle') {
        const x = Number(geometry.x), y = Number(geometry.y);
        const width = Number(geometry.width), height = Number(geometry.height);
        addEdges([{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], 'object', object.object_id);
      }
    });
    return edges;
  }

  function nearestWall(point) {
    return wallEdges().reduce((best, edge) => {
      const projected = nearestPointOnSegment(point, edge.start, edge.end);
      const candidate = { ...edge, ...projected };
      return !best || candidate.distance < best.distance ? candidate : best;
    }, null);
  }

  function anchorPlacement(point, mountType) {
    if (mountType !== 'wall') return { point, wallRef: null };
    const wall = nearestWall(point);
    const threshold = 0.3;
    if (!wall || wall.distance > threshold) {
      setMessage(`Wall-mounted anchors must be within ${threshold.toFixed(1)} m of a boundary or wall`, 'error');
      return null;
    }
    const edgeAngle = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180 / Math.PI;
    const orientationSign = ui.anchorFacingInput.value === 'outside' ? -1 : 1;
    return {
      point: wall.point,
      orientationDeg: (edgeAngle + orientationSign * 90 + 360) % 360,
      wallRef: {
        source: wall.source,
        objectId: wall.objectId,
        edgeIndex: wall.edgeIndex,
        offsetRatio: wall.ratio,
        facingSide: ui.anchorFacingInput.value || 'inside',
      },
    };
  }

  function uniquePolygonPoints(points) {
    const tolerance = Math.max(metresPerPixel() * 2, 1e-9);
    const unique = [];
    points.forEach(point => {
      if (!unique.length || distance(point, unique[unique.length - 1]) > tolerance) {
        unique.push(point);
      }
    });
    if (unique.length > 1 && distance(unique[0], unique[unique.length - 1]) <= tolerance) {
      unique.pop();
    }
    return unique;
  }

  async function saveBoundary(points, record = true, label = 'update plan boundary') {
    const clean = uniquePolygonPoints(points);
    if (clean.length < 3 || polygonArea(clean) <= 1e-9) {
      setMessage('Plan boundary must contain at least 3 points and have a positive area', 'error');
      return false;
    }
    const before = clone(state.plan);
    if (state.isNewPlan) {
      state.plan.boundary = geometryFromPoints('polygon', clean);
      const bounds = boundsForPoints(clean);
      state.plan.width_m = bounds.width;
      state.plan.height_m = bounds.height;
      populatePlanForm();
      renderScene();
      setMessage('Boundary ready · save the Plan to persist it', 'ok');
      return true;
    }
    const response = await safeMutation(() => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}`, {
      method: 'PUT', body: JSON.stringify({ boundary: geometryFromPoints('polygon', clean) }),
    }), record ? 'Plan boundary saved' : null);
    if (!response?.plan) return false;
    Object.assign(state.plan, response.plan);
    try {
      const anchorResult = await api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/anchors`);
      replaceAnchorRows(anchorResult.anchors || []);
    } catch (_error) {
      setMessage('Boundary saved; reload to see updated wall-reference review flags', 'warn');
    }
    populatePlanForm();
    const after = clone(state.plan);
    if (record) recordCommand(label,
      () => saveBoundary(pointsFromGeometry(before.boundary), false),
      () => saveBoundary(pointsFromGeometry(after.boundary), false));
    renderScene();
    return true;
  }

  async function updateVertex(kind, id, index, point, record = true) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      setMessage('Vertex X and Y must be finite numbers', 'error');
      return false;
    }
    const points = editablePoints(kind, id).map(value => ({ ...value }));
    if (!points[index]) return false;
    points[index] = { x: Number(point.x), y: Number(point.y) };
    if (kind === 'boundary') return saveBoundary(points, record, `move boundary vertex ${index + 1}`);
    const zone = state.zones.find(item => String(item.zone_id) === String(id));
    return zone ? updateZone(zone, { geometry: geometryFromPoints('polygon', points) }, record, `move ${zone.name} vertex`) : false;
  }

  async function insertVertex(kind, id, edgeIndex, point) {
    const points = editablePoints(kind, id).map(value => ({ ...value }));
    points.splice(edgeIndex + 1, 0, point);
    if (kind === 'boundary') return saveBoundary(points, true, 'add boundary vertex');
    const zone = state.zones.find(item => String(item.zone_id) === String(id));
    return zone ? updateZone(zone, { geometry: geometryFromPoints('polygon', points) }, true, `add ${zone.name} vertex`) : false;
  }

  async function removeVertex(kind, id, index) {
    const points = editablePoints(kind, id).map(value => ({ ...value }));
    if (points.length <= 3) {
      setMessage('A polygon must keep at least 3 vertices', 'error');
      return false;
    }
    points.splice(index, 1);
    state.selectedVertex = null;
    if (kind === 'boundary') return saveBoundary(points, true, 'remove boundary vertex');
    const zone = state.zones.find(item => String(item.zone_id) === String(id));
    return zone ? updateZone(zone, { geometry: geometryFromPoints('polygon', points) }, true, `remove ${zone.name} vertex`) : false;
  }

  function finishBoundary() {
    const points = uniquePolygonPoints(state.draft?.points || []);
    if (state.tool !== 'boundary' || points.length < 3) {
      setMessage('Plan boundary needs at least 3 points', 'error');
      return;
    }
    state.draft = { kind: 'boundary', points: [], cursor: null };
    renderDraft();
    void saveBoundary(points, true, 'redraw plan boundary');
  }

  async function finishZoneWithName(points) {
    const name = await requestZoneName(nextZoneName());
    if (!name) {
      state.draft = { kind: 'zone', points, cursor: points[points.length - 1] || null };
      renderDraft();
      setMessage('ยังไม่ได้บันทึก Zone — วาดต่อหรือกด Enter เพื่อกำหนดชื่อ');
      return;
    }
    await createZone(points, name);
  }

  function finishZone() {
    if (state.zoneNameOpen) return;
    const points = uniquePolygonPoints(state.draft?.points || []);
    if (state.tool !== 'zone' || points.length < 3) {
      setMessage('Zone ต้องมีอย่างน้อย 3 จุด', 'error');
      return;
    }
    state.draft = { kind: 'zone', points: [], cursor: null };
    renderDraft();
    void finishZoneWithName(points);
  }

  function cancelInteraction() {
    if (state.drag) {
      if (state.drag.mode === 'vertex') setLocalPolygonPoints(state.drag.kind, state.drag.id, state.drag.originalPoints);
      if (state.drag.mode === 'orientation') state.drag.anchor.orientation_deg = state.drag.before;
      if (state.drag.mode === 'entities') state.drag.items.forEach(item => {
        if (['object', 'zone'].includes(item.kind)) item.entity.geometry = clone(item.before);
        else Object.assign(item.entity, item.before);
      });
      state.drag = null;
    }
    state.marquee = null;
    state.pan = null;
    ui.svg.classList.remove('is-panning');
    state.draft = ['zone', 'boundary'].includes(state.tool) ? { kind: state.tool, points: [], cursor: null } : null;
    renderScene();
    setMessage('ยกเลิกแล้ว');
  }

  function beginPan(event) {
    state.pan = {
      clientX: event.clientX,
      clientY: event.clientY,
      view: { ...state.view },
    };
    ui.svg.classList.add('is-panning');
    ui.svg.setPointerCapture(event.pointerId);
  }

  function entityForRef(ref) {
    if (ref.kind === 'boundary') return state.plan;
    const collection = collectionForKind(ref.kind);
    const key = idKeyForKind(ref.kind);
    return collection?.find(entity => String(entity[key]) === String(ref.id)) || null;
  }

  function setLocalPolygonPoints(kind, id, points) {
    if (kind === 'boundary') {
      state.plan.boundary = geometryFromPoints('polygon', points);
      const bounds = boundsForPoints(points);
      state.plan.width_m = bounds.width;
      state.plan.height_m = bounds.height;
      return;
    }
    const zone = state.zones.find(item => String(item.zone_id) === String(id));
    if (zone) zone.geometry = geometryFromPoints('polygon', points);
  }

  function snapshotForDrag(ref) {
    const entity = entityForRef(ref);
    if (!entity) return null;
    if (ref.kind === 'object') return { ...ref, entity, before: clone(entity.geometry) };
    if (ref.kind === 'zone') return { ...ref, entity, before: clone(entity.geometry) };
    if (ref.kind === 'anchor') return { ...ref, entity, before: { x: Number(entity.x), y: Number(entity.y), wall_ref: clone(entity.wall_ref) } };
    if (ref.kind === 'dimension') return { ...ref, entity, before: { x1: entity.x1, y1: entity.y1, x2: entity.x2, y2: entity.y2 } };
    return null;
  }

  function translateDragItem(item, dx, dy) {
    if (item.kind === 'object') item.entity.geometry = translatedGeometry(item.before, dx, dy);
    if (item.kind === 'zone') item.entity.geometry = translatedGeometry(item.before, dx, dy);
    if (item.kind === 'anchor') {
      let next = { x: item.before.x + dx, y: item.before.y + dy };
      if (item.entity.mount_type === 'wall') {
        const placement = anchorPlacement(next, 'wall');
        if (placement) {
          next = placement.point;
          item.entity.wall_ref = placement.wallRef;
        }
      }
      item.entity.x = next.x;
      item.entity.y = next.y;
    }
    if (item.kind === 'dimension') {
      item.entity.x1 = Number(item.before.x1) + dx;
      item.entity.y1 = Number(item.before.y1) + dy;
      item.entity.x2 = Number(item.before.x2) + dx;
      item.entity.y2 = Number(item.before.y2) + dy;
    }
  }

  async function updateObjectGeometry(object, geometry, record = true) {
    const before = clone(object.geometry);
    const response = await safeMutation(() => api(
      `/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects/${encodeURIComponent(object.object_id)}`,
      { method: 'PUT', body: JSON.stringify({ geometry }) },
    ));
    if (!response?.object) return false;
    Object.assign(object, response.object);
    const after = clone(object.geometry);
    if (record) recordCommand('move object',
      () => updateObjectGeometry(object, before, false),
      () => updateObjectGeometry(object, after, false));
    renderScene();
    return true;
  }

  async function updateDimensionEntity(dimension, values, record = true) {
    const before = clone(dimension);
    const response = await safeMutation(() => api(
      `/api/plans/${encodeURIComponent(state.plan.plan_id)}/dimensions/${encodeURIComponent(dimension.dimension_id)}`,
      { method: 'PUT', body: JSON.stringify(values) },
    ));
    if (!response?.dimension) return false;
    Object.assign(dimension, response.dimension);
    const after = clone(dimension);
    if (record) recordCommand('move dimension',
      () => updateDimensionEntity(dimension, payloadForEntity('dimension', before), false),
      () => updateDimensionEntity(dimension, payloadForEntity('dimension', after), false));
    renderScene();
    return true;
  }

  async function persistDrag(drag) {
    const changed = [];
    for (const item of drag.items) {
      if (item.kind === 'object') {
        const after = clone(item.entity.geometry);
        item.entity.geometry = clone(item.before);
        if (await updateObjectGeometry(item.entity, after, false)) changed.push({ ...item, after });
      }
      if (item.kind === 'zone') {
        const after = clone(item.entity.geometry);
        item.entity.geometry = clone(item.before);
        if (await updateZone(item.entity, { geometry: after }, false)) changed.push({ ...item, after });
      }
      if (item.kind === 'anchor') {
        const after = { x: item.entity.x, y: item.entity.y, wall_ref: clone(item.entity.wall_ref) };
        Object.assign(item.entity, item.before);
        if (await updateAnchor(item.entity, after, false)) changed.push({ ...item, after });
      }
      if (item.kind === 'dimension') {
        const after = payloadForEntity('dimension', item.entity);
        Object.assign(item.entity, item.before);
        if (await updateDimensionEntity(item.entity, after, false)) changed.push({ ...item, after });
      }
    }
    if (changed.length) recordCommand(changed.length > 1 ? 'move group' : `move ${changed[0].kind}`,
      async () => applyDragValues(changed, 'before'),
      async () => applyDragValues(changed, 'after'));
  }

  async function applyDragValues(items, property) {
    for (const item of items) {
      const value = clone(item[property]);
      let ok = false;
      if (item.kind === 'object') ok = await updateObjectGeometry(item.entity, value, false);
      if (item.kind === 'zone') ok = await updateZone(item.entity, { geometry: value }, false);
      if (item.kind === 'anchor') ok = await updateAnchor(item.entity, value, false);
      if (item.kind === 'dimension') ok = await updateDimensionEntity(item.entity, value, false);
      if (!ok) return false;
    }
    return true;
  }

  function boundsForEntity(kind, entity) {
    if (kind === 'zone') return boundsForPoints(zonePoints(entity));
    if (kind === 'anchor') return { xMin: Number(entity.x), xMax: Number(entity.x), yMin: Number(entity.y), yMax: Number(entity.y) };
    if (kind === 'dimension') return boundsForPoints([
      { x: Number(entity.x1), y: Number(entity.y1) }, { x: Number(entity.x2), y: Number(entity.y2) },
    ]);
    const geometry = entity.geometry || {};
    const points = pointsFromGeometry(geometry);
    if (points.length) return boundsForPoints(points);
    const x = Number(geometry.x), y = Number(geometry.y);
    return { xMin: x, xMax: x + Number(geometry.width || 0), yMin: y, yMax: y + Number(geometry.height || 0) };
  }

  function selectByMarquee(marquee) {
    const box = boundsForPoints([marquee.start, marquee.end]);
    const refs = [];
    for (const kind of ['object', 'zone', 'anchor', 'dimension']) {
      const key = idKeyForKind(kind);
      collectionForKind(kind).forEach(entity => {
        const bounds = boundsForEntity(kind, entity);
        const intersects = bounds.xMax >= box.xMin && bounds.xMin <= box.xMax
          && bounds.yMax >= box.yMin && bounds.yMin <= box.yMax;
        if (intersects) refs.push({ kind, id: entity[key] });
      });
    }
    if (marquee.additive) {
      const known = new Set(state.selections.map(selectionKey));
      refs.forEach(ref => { if (!known.has(selectionKey(ref))) state.selections.push(ref); });
    } else state.selections = refs;
    syncPrimarySelection();
    renderScene();
  }

  function onPointerDown(event) {
    if (!state.plan) return;
    ui.svg.focus({ preventScroll: true });
    if (event.button === 1 || (event.button === 0 && state.spaceDown)) {
      event.preventDefault();
      beginPan(event);
      return;
    }
    if (event.button !== 0) return;

    let point = pointerMetres(event, true);
    const drawingStart = activeSegment()?.start;
    if (drawingStart) point = snapAnglePoint(drawingStart, point, event.shiftKey);
    if (['zone', 'boundary'].includes(state.tool)) point = snapToAlignments(point);
    if (state.tool === 'select') {
      const target = event.target.closest?.('[data-kind]');
      if (!target) {
        if (!event.shiftKey) {
          state.selections = [];
          syncPrimarySelection();
        }
        state.marquee = { start: point, end: point, additive: event.shiftKey };
        ui.svg.setPointerCapture(event.pointerId);
        renderScene();
        return;
      }
      const kind = target.dataset.kind;
      const id = target.dataset.id;
      if (target.dataset.edgeIndex !== undefined && state.canEdit) {
        const edgeIndex = Number(target.dataset.edgeIndex);
        const points = editablePoints(kind, id);
        const start = points[edgeIndex], end = points[(edgeIndex + 1) % points.length];
        const projected = nearestPointOnSegment(point, start, end).point;
        void insertVertex(kind, id, edgeIndex, projected);
        return;
      }
      if (target.dataset.vertexIndex !== undefined && state.canEdit) {
        if (!isSelected(kind, id)) selectEntity(kind, id);
        const index = Number(target.dataset.vertexIndex);
        state.selectedVertex = { kind, id, index };
        state.drag = {
          mode: 'vertex', kind, id, index, start: point,
          originalPoints: editablePoints(kind, id).map(value => ({ ...value })),
        };
        ui.svg.setPointerCapture(event.pointerId);
        renderScene();
        return;
      }
      if (target.dataset.orientationHandle && state.canEdit) {
        if (!isSelected(kind, id)) selectEntity(kind, id);
        const anchor = entityForRef({ kind, id });
        state.drag = { mode: 'orientation', anchor, before: Number(anchor.orientation_deg || 0) };
        ui.svg.setPointerCapture(event.pointerId);
        return;
      }
      if (event.shiftKey) toggleEntitySelection(kind, id);
      else if (!isSelected(kind, id)) selectEntity(kind, id);
      if (state.canEdit && ['object', 'zone', 'anchor', 'dimension'].includes(kind)) {
        state.drag = {
          mode: 'entities',
          start: point,
          items: state.selections.map(snapshotForDrag).filter(Boolean),
        };
        ui.svg.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (!state.canEdit && !(state.tool === 'boundary' && state.isNewPlan)) return;
    if (state.tool === 'anchor') {
      void createAnchor(point);
      return;
    }
    if (['zone', 'boundary'].includes(state.tool)) {
      const points = state.draft?.points || [];
      const closeTolerance = metresPerPixel() * 12;
      if (points.length >= 3 && distance(point, points[0]) <= closeTolerance) {
        if (state.tool === 'boundary') finishBoundary();
        else finishZone();
      } else {
        points.push(point);
        state.draft = { kind: state.tool, points, cursor: point };
        renderDraft();
        if (points.length === 1) focusPrecisionLength();
      }
      return;
    }
    if (state.tool === 'dimension') {
      if (state.draft?.kind !== 'dimension' || !state.draft.start) {
        state.draft = { kind: 'dimension', start: point, end: point };
        setMessage(`Dimension start: X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)} m — คลิกจุดปลาย`);
        renderDraft();
        focusPrecisionLength();
        return;
      }
      const start = state.draft.start;
      if (distance(start, point) <= 1e-9) {
        state.draft.end = point;
        setMessage('จุดปลาย Dimension ต้องต่างจากจุดเริ่ม', 'error');
        renderDraft();
        return;
      }
      state.draft = null;
      renderDraft();
      void createDimension(start, point);
      return;
    }
    if (state.tool === 'line') {
      if (state.draft?.kind !== 'line' || !state.draft.start) {
        state.draft = { kind: 'line', start: point, end: point };
        renderDraft();
        setMessage(`Line start: X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)} m — click an end or type exact values`);
        focusPrecisionLength();
        return;
      }
      const start = state.draft.start;
      if (distance(start, point) <= 1e-9) {
        setMessage('The line end must be different from its start', 'error');
        return;
      }
      state.draft = null;
      renderDraft();
      void createObject('line', start, point);
      return;
    }
    if (state.tool === 'rectangle') {
      state.draft = { kind: 'rectangle', start: point, end: point };
      ui.svg.setPointerCapture(event.pointerId);
      renderDraft();
    }
  }

  function onDoubleClick(event) {
    const canFinishBoundaryDraft = state.tool === 'boundary' && state.isNewPlan;
    if (!['zone', 'boundary'].includes(state.tool) || (!state.canEdit && !canFinishBoundaryDraft) || state.zoneNameOpen) return;
    event.preventDefault();
    if (state.tool === 'boundary') finishBoundary();
    else finishZone();
  }

  function onPointerMove(event) {
    if (!state.plan) return;
    const raw = pointerMetres(event, false);
    let snapped = snapPoint(raw);
    const segmentStart = activeSegment()?.start;
    if (segmentStart) snapped = snapAnglePoint(segmentStart, snapped, event.shiftKey);
    if (['zone', 'boundary'].includes(state.draft?.kind)) snapped = snapToAlignments(snapped);
    ui.cursor.textContent = `X ${snapped.x.toFixed(2)} · Y ${snapped.y.toFixed(2)} m`;

    if (state.pan) {
      const rect = canvasRect();
      const dx = ((event.clientX - state.pan.clientX) / Math.max(1, rect.width)) * state.pan.view.width;
      const dy = ((event.clientY - state.pan.clientY) / Math.max(1, rect.height)) * state.pan.view.height;
      state.view.x = state.pan.view.x - dx;
      state.view.y = state.pan.view.y - dy;
      applyViewBox(false);
      return;
    }

    if (state.tool === 'anchor' && ui.anchorMountTypeInput.value === 'wall') {
      const candidate = nearestWall(raw);
      state.wallCandidate = candidate && candidate.distance <= 0.3 ? candidate : null;
      renderDraft();
    } else if (state.wallCandidate) {
      state.wallCandidate = null;
      renderDraft();
    }

    if (state.drag) {
      if (state.drag.mode === 'vertex') {
        const points = state.drag.originalPoints.map(value => ({ ...value }));
        points[state.drag.index] = snapped;
        setLocalPolygonPoints(state.drag.kind, state.drag.id, points);
      } else if (state.drag.mode === 'orientation') {
        const anchor = state.drag.anchor;
        anchor.orientation_deg = (Math.atan2(snapped.y - Number(anchor.y), snapped.x - Number(anchor.x)) * 180 / Math.PI + 360) % 360;
      } else {
        const dx = snapped.x - state.drag.start.x;
        const dy = snapped.y - state.drag.start.y;
        state.drag.items.forEach(item => translateDragItem(item, dx, dy));
      }
      renderScene();
      return;
    }

    if (state.marquee) {
      state.marquee.end = snapped;
      renderDraft();
      return;
    }

    if (['zone', 'boundary'].includes(state.draft?.kind)) {
      state.draft.cursor = snapped;
      renderDraft();
    } else if (state.draft?.start) {
      state.draft.end = snapped;
      renderDraft();
    }
  }

  function onPointerUp(event) {
    if (state.pan) {
      state.pan = null;
      ui.svg.classList.remove('is-panning');
      return;
    }
    if (state.drag) {
      const drag = state.drag;
      state.drag = null;
      if (drag.mode === 'vertex') {
        const point = editablePoints(drag.kind, drag.id)[drag.index];
        setLocalPolygonPoints(drag.kind, drag.id, drag.originalPoints);
        void updateVertex(drag.kind, drag.id, drag.index, point, true);
      } else if (drag.mode === 'orientation') {
        const after = Number(drag.anchor.orientation_deg || 0);
        drag.anchor.orientation_deg = drag.before;
        void updateAnchor(drag.anchor, { orientation_deg: after }, true, `rotate ${drag.anchor.anchor_id}`);
      } else void persistDrag(drag);
      return;
    }
    if (state.marquee) {
      const marquee = state.marquee;
      state.marquee = null;
      selectByMarquee(marquee);
      try { ui.svg.releasePointerCapture(event.pointerId); } catch (_error) { /* already released */ }
      return;
    }
    const draft = state.draft;
    if (!draft?.start || !draft.end) return;
    if (draft.kind !== 'rectangle') return;
    state.draft = null;
    renderDraft();
    if (distance(draft.start, draft.end) < state.gridStep * 0.05) {
      setMessage('ระยะสั้นเกินไป จึงยังไม่ได้สร้างวัตถุ', 'error');
      return;
    }
    void createObject(draft.kind, draft.start, draft.end);
    try { ui.svg.releasePointerCapture(event.pointerId); } catch (_error) { /* already released */ }
  }

  function wireEditorEvents() {
    document.querySelectorAll('[data-tool]').forEach(button => {
      button.addEventListener('click', () => setTool(button.dataset.tool));
    });
    document.getElementById('tool-delete').addEventListener('click', () => void deleteSelection());
    document.getElementById('tool-undo').addEventListener('click', () => void undo());
    document.getElementById('tool-redo').addEventListener('click', () => void redo());
    document.getElementById('tool-copy').addEventListener('click', copySelection);
    document.getElementById('tool-duplicate').addEventListener('click', () => void duplicateSelection());
    ui.drawBoundary.addEventListener('click', () => setTool('boundary'));
    ui.saveZoneProperties.addEventListener('click', () => void saveZoneProperties());
    ui.saveVertexProperties.addEventListener('click', () => {
      if (!state.selectedVertex) return;
      void updateVertex(state.selectedVertex.kind, state.selectedVertex.id, state.selectedVertex.index, {
        x: Number(ui.vertexXInput.value), y: Number(ui.vertexYInput.value),
      });
    });
    document.getElementById('tool-grid').addEventListener('click', event => {
      state.gridVisible = !state.gridVisible;
      event.currentTarget.classList.toggle('is-active', state.gridVisible);
      event.currentTarget.setAttribute('aria-pressed', String(state.gridVisible));
      updateGrid();
    });
    document.getElementById('tool-snap').addEventListener('click', event => {
      state.snapEnabled = !state.snapEnabled;
      event.currentTarget.classList.toggle('is-active', state.snapEnabled);
      event.currentTarget.setAttribute('aria-pressed', String(state.snapEnabled));
      setMessage(`Snap ${state.snapEnabled ? 'เปิด' : 'ปิด'}`);
    });
    document.getElementById('tool-angle-snap').addEventListener('click', event => {
      state.angleSnapEnabled = !state.angleSnapEnabled;
      event.currentTarget.classList.toggle('is-active', state.angleSnapEnabled);
      event.currentTarget.setAttribute('aria-pressed', String(state.angleSnapEnabled));
    });
    document.getElementById('tool-labels').addEventListener('click', event => {
      state.labelsVisible = !state.labelsVisible;
      event.currentTarget.classList.toggle('is-active', state.labelsVisible);
      event.currentTarget.setAttribute('aria-pressed', String(state.labelsVisible));
      renderScene();
      setMessage(`Labels ${state.labelsVisible ? 'shown' : 'hidden'} · anchor and zone dots remain visible`);
    });
    document.getElementById('tool-fit').addEventListener('click', fitView);
    document.getElementById('tool-zoom-in').addEventListener('click', () => zoomAt(0.8));
    document.getElementById('tool-zoom-out').addEventListener('click', () => zoomAt(1.25));
    ui.saveAnchorProperties.addEventListener('click', () => void saveAnchorProperties());
    ui.anchorMountTypeInput.addEventListener('change', () => {
      ui.anchorWallRefField.hidden = ui.anchorMountTypeInput.value !== 'wall';
      if (ui.anchorMountTypeInput.value === 'ceiling' && Number(ui.anchorZInput.value || 0) <= 0) {
        ui.anchorZInput.value = String(Number(state.plan?.ceiling_height_m || 3));
      }
    });
    ui.saveLineProperties.addEventListener('click', () => void saveLineProperties());
    ui.precisionForm.addEventListener('submit', event => {
      event.preventDefault();
      void applyPrecisionInput();
    });
    ui.precisionLength.addEventListener('input', previewPrecisionInput);
    ui.precisionAngle.addEventListener('input', previewPrecisionInput);
    ui.registerHardware.addEventListener('click', () => void registerHardware());
    ui.gridSize.addEventListener('change', () => {
      const value = Number(ui.gridSize.value);
      if (!Number.isFinite(value) || value <= 0) {
        ui.gridSize.value = String(state.gridStep);
        return setMessage('Grid spacing ต้องมากกว่า 0 เมตร', 'error');
      }
      state.gridStep = value;
      updateGrid();
      setMessage(`Grid / Snap ${value} m`);
    });

    ui.svg.addEventListener('pointerdown', onPointerDown);
    ui.svg.addEventListener('pointermove', onPointerMove);
    ui.svg.addEventListener('pointerup', onPointerUp);
    ui.svg.addEventListener('dblclick', onDoubleClick);
    ui.svg.addEventListener('pointercancel', cancelInteraction);
    ui.svg.addEventListener('contextmenu', event => {
      event.preventDefault();
      const target = event.target.closest?.('[data-vertex-index]');
      if (target && state.canEdit) {
        void removeVertex(target.dataset.kind, target.dataset.id, Number(target.dataset.vertexIndex));
      }
    });
    ui.svg.addEventListener('wheel', event => {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? 0.88 : 1.14, event.clientX, event.clientY);
    }, { passive: false });

    document.addEventListener('keydown', event => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.code === 'Space' && !typing) {
        state.spaceDown = true;
        event.preventDefault();
      }
      if (event.key === 'Escape') cancelInteraction();
      if (event.key === 'Enter' && state.tool === 'zone' && !typing) finishZone();
      if (event.key === 'Enter' && state.tool === 'boundary' && !typing) finishBoundary();
      if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const shortcut = { l: 'line', r: 'rectangle', z: 'zone', d: 'dimension' }[event.key.toLowerCase()];
        if (shortcut) {
          event.preventDefault();
          setTool(shortcut);
        }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
        event.preventDefault();
        void deleteSelection();
      }
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
      }
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        void redo();
      }
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault(); copySelection();
      }
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault(); void pasteClipboard();
      }
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault(); void duplicateSelection();
      }
    });
    document.addEventListener('keyup', event => {
      if (event.code === 'Space') state.spaceDown = false;
    });

    ui.projectSelect.addEventListener('change', onProjectChanged);
    ui.planSelect.addEventListener('change', () => {
      const planId = ui.planSelect.value;
      if (planId) void loadPlan(planId);
      else showEmptyCanvas('เลือกแปลน หรือกดเพิ่มแปลนเพื่อเริ่มต้น');
    });
    ui.newPlan.addEventListener('click', beginNewPlan);
    ui.editPlan.addEventListener('click', beginEditPlan);
    ui.savePlan.addEventListener('click', () => void savePlan());
    ui.logout.addEventListener('click', async () => {
      try { await api('/api/signout', { method: 'POST' }); } catch (_error) { /* leave anyway */ }
      localStorage.removeItem('tw_token');
      session.token = null;
      window.location.href = 'login.html';
    });

    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => adjustViewToCanvas());
      observer.observe(ui.canvasWrap);
    } else {
      window.addEventListener('resize', adjustViewToCanvas);
    }
  }

  function updateUser(user) {
    const fullName = `${user.first_th || user.first_en || ''} ${user.last_th || user.last_en || ''}`.trim();
    ui.userName.textContent = fullName || user.email || user.employee_id;
    ui.userMeta.textContent = `${user.employee_id} · ${user.position || user.role}`;
    ui.avatar.textContent = `${(user.first_en || '?')[0]}${(user.last_en || '')[0] || ''}`.toUpperCase();
    state.isAdmin = user.role === 'admin';
    state.canEdit = false;
    ui.roleHint.textContent = state.canEdit
      ? 'Admin · สามารถวาด แก้ไข และลบ plan objects ได้'
      : `Read only · role ${user.role} ไม่มีสิทธิ์แก้ไขแปลน`;
    ui.roleHint.classList.toggle('can-edit', state.canEdit);
    document.querySelectorAll('[data-tool]').forEach(button => {
      if (EDIT_TOOLS.has(button.dataset.tool)) button.disabled = !state.canEdit;
    });
    document.getElementById('tool-delete').disabled = !state.canEdit;
    updatePlanControls();
  }

  function projectById(projectId) {
    return state.projects.find(project => String(project.project_id) === String(projectId)) || null;
  }

  function projectForPlan(planId) {
    return state.projects.find(project => (project.plans || []).some(
      plan => String(plan.plan_id) === String(planId)
    )) || null;
  }

  function setSelectOptions(select, items, placeholder) {
    select.replaceChildren(new Option(placeholder, ''));
    items.forEach(item => select.add(new Option(item.label, item.value)));
  }

  function renderPlanOptions(selectedPlanId = '') {
    const project = projectById(ui.projectSelect.value);
    const plans = (project?.plans || []).map(plan => ({
      value: String(plan.plan_id),
      label: `${plan.name}${plan.live ? ' · ใช้งานอยู่' : ''}`,
    }));
    setSelectOptions(ui.planSelect, plans, plans.length ? 'เลือกแปลน' : 'โครงการนี้ยังไม่มีแปลน');
    if (plans.some(plan => plan.value === String(selectedPlanId))) {
      ui.planSelect.value = String(selectedPlanId);
    }
    updatePlanControls();
  }

  async function loadProjects(preferredProjectId = '', preferredPlanId = '') {
    const result = await api('/api/projects');
    state.projects = result.projects || [];
    setSelectOptions(
      ui.projectSelect,
      state.projects.map(project => ({ value: String(project.project_id), label: project.name })),
      state.projects.length ? 'เลือกโครงการ' : 'ยังไม่มีโครงการ',
    );

    const planProject = preferredPlanId ? projectForPlan(preferredPlanId) : null;
    const projectId = planProject?.project_id || preferredProjectId;
    if (projectById(projectId)) ui.projectSelect.value = String(projectId);
    else if (state.projects.length) ui.projectSelect.value = String(state.projects[0].project_id);
    renderPlanOptions(preferredPlanId);
  }

  function resetPlanEntities() {
    state.objects = [];
    state.zones = [];
    state.anchors = [];
    state.dimensions = [];
    state.selected = null;
    state.selections = [];
    state.selectedVertex = null;
    state.draft = null;
    state.drag = null;
    state.undoStack = [];
    state.redoStack = [];
  }

  function showEmptyCanvas(message = 'เลือกโครงการและแปลน หรือกดเพิ่มแปลน') {
    cancelInteraction();
    state.plan = null;
    state.editMode = false;
    state.isNewPlan = false;
    resetPlanEntities();
    ui.planTitle.textContent = 'Plan Editor';
    ui.planMeta.textContent = 'พิกัดทั้งหมดใช้หน่วยเมตร · ยังไม่ได้เลือกแปลน';
    document.title = 'Plan Editor | SUPALAI';
    const url = new URL(window.location.href);
    url.searchParams.delete('plan_id');
    history.replaceState(null, '', url);
    state.view = { x: -1, y: -1, width: 22, height: 22 };
    state.fitWidth = 22;
    hideLoading();
    applyViewBox(true);
    updatePlanControls();
    setMessage(message);
  }

  function onProjectChanged() {
    renderPlanOptions();
    showEmptyCanvas('เลือกแปลนของโครงการนี้ หรือกดเพิ่มแปลน');
  }

  function beginNewPlan() {
    if (!state.isAdmin || !ui.projectSelect.value) return;
    cancelInteraction();
    resetPlanEntities();
    state.plan = {
      plan_id: '',
      project_id: ui.projectSelect.value,
      name: '',
      width_m: 20,
      height_m: 20,
      boundary: geometryFromPoints('polygon', [
        { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
      ]),
      ceiling_height_m: 3,
      is_active: true,
      version: 1,
    };
    state.isNewPlan = true;
    state.editMode = true;
    ui.planSelect.value = '';
    ui.planTitle.textContent = 'แปลนใหม่';
    ui.planMeta.textContent = `${projectById(state.plan.project_id)?.name || state.plan.project_id} · ยังไม่ได้บันทึก`;
    populatePlanForm();
    hideLoading();
    fitView();
    updatePlanControls();
    ui.planInput.focus();
    setMessage('กรอก Plan properties แล้วกดบันทึกเพื่อสร้างแปลนในฐานข้อมูล');
  }

  function beginEditPlan() {
    if (!state.isAdmin || !hasPersistedPlan()) return;
    state.editMode = true;
    populatePlanForm();
    updatePlanControls();
    ui.planNameInput.focus();
    setMessage('เข้าสู่โหมดแก้ไขแล้ว');
  }

  function planPayloadFromForm() {
    const planId = ui.planInput.value.trim();
    const name = ui.planNameInput.value.trim();
    const width = Number(ui.planWidthInput.value);
    const height = Number(ui.planHeightInput.value);
    const version = Number(ui.planVersionInput.value);
    const ceilingHeight = Number(ui.planCeilingInput.value);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(planId)) {
      throw new Error('Plan ID ต้องใช้ตัวอักษร ตัวเลข จุด ขีดกลาง หรือ underscore และห้ามเว้นวรรค');
    }
    if (!name) throw new Error('กรุณาระบุชื่อแปลน');
    if (!Number.isFinite(width) || width <= 0) throw new Error('ความกว้างต้องมากกว่า 0 เมตร');
    if (!Number.isFinite(height) || height <= 0) throw new Error('ความสูงต้องมากกว่า 0 เมตร');
    if (!Number.isInteger(version) || version < 1) throw new Error('Version ต้องเป็นจำนวนเต็มตั้งแต่ 1');
    if (!Number.isFinite(ceilingHeight) || ceilingHeight <= 0) {
      throw new Error('Ceiling height must be greater than 0 metres');
    }
    return {
      plan_id: planId,
      name,
      width_m: width,
      height_m: height,
      boundary: geometryFromPoints('polygon', boundaryPoints()),
      ceiling_height_m: ceilingHeight,
      is_active: ui.planActiveInput.checked,
      version,
    };
  }

  async function savePlan() {
    if (!state.isAdmin || !state.editMode || !state.plan) return;
    if (state.draft?.kind === 'boundary' && state.draft.points.length) {
      setMessage('Close the plan boundary before saving (click the first point, Enter, or double-click)', 'error');
      return;
    }
    let payload;
    try {
      payload = planPayloadFromForm();
    } catch (error) {
      setMessage(error.message, 'error');
      return;
    }

    const creating = state.isNewPlan;
    const before = clone(state.plan);
    const projectId = state.plan.project_id;
    const endpoint = creating
      ? `/api/projects/${encodeURIComponent(projectId)}/plans`
      : `/api/plans/${encodeURIComponent(state.plan.plan_id)}`;
    const requestBody = creating ? payload : {
      name: payload.name,
      width_m: payload.width_m,
      height_m: payload.height_m,
      boundary: payload.boundary,
      ceiling_height_m: payload.ceiling_height_m,
      is_active: payload.is_active,
      version: payload.version,
    };
    const response = await safeMutation(
      () => api(endpoint, { method: creating ? 'POST' : 'PUT', body: JSON.stringify(requestBody) }),
      null,
    );
    if (!response?.plan) return;

    if (creating) {
      await loadProjects(projectId, response.plan.plan_id);
      await loadPlan(response.plan.plan_id);
    } else {
      Object.assign(state.plan, response.plan);
      const after = clone(state.plan);
      state.editMode = false;
      populatePlanForm();
      updatePlanControls();
      renderScene();
      recordCommand('update plan properties',
        () => updatePlanProperties(before),
        () => updatePlanProperties(after));
    }
    setMessage(creating ? 'สร้างแปลนและบันทึกลงฐานข้อมูลแล้ว' : 'บันทึกการแก้ไขแปลนแล้ว', 'ok');
  }

  async function updatePlanProperties(values) {
    const payload = {
      name: values.name,
      boundary: values.boundary,
      ceiling_height_m: values.ceiling_height_m,
      is_active: values.is_active,
      version: values.version,
    };
    const response = await safeMutation(() => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }));
    if (!response?.plan) return false;
    Object.assign(state.plan, response.plan);
    populatePlanForm();
    renderScene();
    return true;
  }

  async function loadPlan(planId) {
    if (!planId) {
      showLoading('ไม่พบ plan_id กรุณาระบุ Plan ID', true);
      return;
    }
    showLoading(`กำลังโหลด ${planId}...`);
    state.selected = null;
    state.selections = [];
    state.selectedVertex = null;
    state.draft = null;
    state.undoStack = [];
    state.redoStack = [];
    try {
      const encoded = encodeURIComponent(planId);
      const [planResult, objectResult, zoneResult, anchorResult, dimensionResult] = await Promise.all([
        api(`/api/plans/${encoded}`),
        api(`/api/plans/${encoded}/objects`),
        api(`/api/plans/${encoded}/zones`),
        api(`/api/plans/${encoded}/anchors`),
        api(`/api/plans/${encoded}/dimensions`),
      ]);
      state.plan = planResult.plan;
      state.objects = objectResult.objects || [];
      state.zones = zoneResult.zones || [];
      state.anchors = anchorResult.anchors || [];
      state.dimensions = dimensionResult.dimensions || [];
      state.isNewPlan = false;
      state.editMode = false;
      const project = projectForPlan(state.plan.plan_id);
      if (project) {
        ui.projectSelect.value = String(project.project_id);
        renderPlanOptions(state.plan.plan_id);
      }
      populatePlanForm();
      ui.planTitle.textContent = state.plan.name;
      ui.planMeta.textContent = `${state.plan.plan_id} · ${Number(state.plan.width_m).toFixed(2)} × ${Number(state.plan.height_m).toFixed(2)} m · Version ${state.plan.version}`;
      document.title = `${state.plan.name} | Plan Editor`;
      const url = new URL(window.location.href);
      url.searchParams.set('plan_id', state.plan.plan_id);
      history.replaceState(null, '', url);
      hideLoading();
      fitView();
      setTool('select');
      updatePlanControls();
    } catch (error) {
      showLoading(`โหลดแปลนไม่สำเร็จ: ${error?.message || error}`, true);
      setMessage('ตรวจสอบ Plan ID และการเชื่อมต่อ backend', 'error');
    }
  }

  async function initialise() {
    wireEditorEvents();
    if (!session.token) {
      window.location.replace('login.html');
      return;
    }
    try {
      const me = await api('/api/me');
      session.user = me.user;
      updateUser(me.user);
    } catch (_error) {
      localStorage.removeItem('tw_token');
      window.location.replace('login.html');
      return;
    }

    const planId = new URLSearchParams(window.location.search).get('plan_id') || '';
    try {
      await loadProjects('', planId);
    } catch (error) {
      showLoading(`โหลดรายการโครงการและแปลนไม่สำเร็จ: ${error?.message || error}`, true);
      return;
    }
    if (planId) await loadPlan(planId);
    else showEmptyCanvas('เลือกแปลน หรือกดเพิ่มแปลนเพื่อเริ่มจาก canvas ว่าง');
  }

  window.SUPALAI_PLAN_EDITOR = Object.freeze({
    pointInPolygon,
    zoneAtPoint,
  });

  void initialise().catch(error => {
    showLoading(`เปิด Plan Editor ไม่สำเร็จ: ${error?.message || error}`, true);
  });
})();
