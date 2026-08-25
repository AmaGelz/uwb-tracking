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
  const EDIT_TOOLS = new Set(['line', 'rectangle', 'zone', 'anchor', 'dimension']);

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
    planVersionInput: document.getElementById('plan-version-input'),
    planActiveInput: document.getElementById('plan-active-input'),
    selectionSummary: document.getElementById('selection-summary'),
    selectionDetails: document.getElementById('selection-details'),
    anchorSettings: document.getElementById('anchor-settings'),
    anchorSettingsTitle: document.getElementById('anchor-settings-title'),
    anchorIdInput: document.getElementById('anchor-id-input'),
    anchorZInput: document.getElementById('anchor-z-input'),
    anchorMountInput: document.getElementById('anchor-mount-input'),
    saveAnchorProperties: document.getElementById('save-anchor-properties'),
    lineSettings: document.getElementById('line-settings'),
    lineLengthInput: document.getElementById('line-length-input'),
    lineAngleInput: document.getElementById('line-angle-input'),
    saveLineProperties: document.getElementById('save-line-properties'),
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
    draft: null,
    drag: null,
    pan: null,
    spaceDown: false,
    gridVisible: true,
    snapEnabled: true,
    gridStep: 1,
    isAdmin: false,
    editMode: false,
    isNewPlan: false,
    canEdit: false,
    busy: false,
    zoneNameOpen: false,
    view: { x: -1, y: -1, width: 22, height: 22 },
    fitWidth: 22,
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
    return Math.max(0.01, Number(state.plan?.width_m) || 20);
  }

  function heightMetres() {
    return Math.max(0.01, Number(state.plan?.height_m) || 20);
  }

  // World coordinates are Cartesian metres (Y grows upward). SVG Y grows
  // downward, so this is the only axis conversion used by render functions.
  const svgY = worldY => heightMetres() - worldY;
  const worldY = svgCoordinateY => heightMetres() - svgCoordinateY;

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

  function linePoints(object) {
    if (!object) return [];
    const type = String(object.geometry?.type || object.object_type || '').toLowerCase();
    const points = pointsFromGeometry(object.geometry);
    return type === 'line' && points.length >= 2 ? points.slice(0, 2) : [];
  }

  function entityGroup(kind, id) {
    const group = svgElement('g', {
      class: `editor-entity${isSelected(kind, id) ? ' is-selected' : ''}`,
      'data-kind': kind,
      'data-id': id,
    });
    return group;
  }

  function isSelected(kind, id) {
    return Boolean(
      state.selected
      && state.selected.kind === kind
      && String(state.selected.id) === String(id)
    );
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
    if (!text) return;
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
    const boundary = svgElement('rect', {
      class: 'plan-boundary',
      x: 0,
      y: 0,
      width: widthMetres(),
      height: heightMetres(),
    });
    ui.boundaryLayer.appendChild(boundary);

    const scale = visualScale();
    const origin = svgElement('text', {
      class: 'plan-axis',
      x: scale.offset,
      y: heightMetres() - scale.offset,
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
      addLabel(group, object.label || object.object_type, labelX, labelY, 'middle');
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

  function renderZones() {
    clearLayer(ui.zoneLayer);
    const scale = visualScale();
    state.zones.forEach(zone => {
      const points = zonePoints(zone);
      const group = entityGroup('zone', zone.zone_id);
      group.appendChild(svgElement('polygon', {
        class: 'editor-shape zone-shape',
        points: pointString(points),
      }));
      const x = Math.min(...points.map(point => point.x)) + scale.offset;
      const y = svgY(Math.max(...points.map(point => point.y))) + scale.label + scale.offset;
      addLabel(group, zone.name, x, y);
      ui.zoneLayer.appendChild(group);
    });
  }

  function renderAnchors() {
    clearLayer(ui.anchorLayer);
    const scale = visualScale();
    state.anchors.forEach(anchor => {
      const x = Number(anchor.x);
      const y = svgY(Number(anchor.y));
      const size = scale.anchor;
      const group = entityGroup('anchor', anchor.anchor_id);
      group.appendChild(svgElement('path', {
        class: 'editor-shape anchor-shape',
        d: `M ${x} ${y - size} L ${x + size} ${y} L ${x} ${y + size} L ${x - size} ${y} Z`,
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
    if (!state.draft) return;
    const draft = state.draft;
    const scale = visualScale();

    if (draft.kind === 'zone') {
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
      return;
    }

    if (!draft.start || !draft.end) return;
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
    const planWidth = widthMetres();
    const planHeight = heightMetres();
    const margin = Math.max(0.5, Math.max(planWidth, planHeight) * 0.06);
    let width = planWidth + margin * 2;
    let height = planHeight + margin * 2;
    const rect = canvasRect();
    const canvasAspect = Math.max(0.2, rect.width / Math.max(1, rect.height));
    if (width / height > canvasAspect) height = width / canvasAspect;
    else width = height * canvasAspect;
    state.view = {
      x: planWidth / 2 - width / 2,
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
    if (kind === 'anchor') {
      return {
        ID: entity.anchor_id,
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
    ui.planSettings.hidden = !state.plan;
    ui.selectionSummary.textContent = entity
      ? `${state.selected.kind[0].toUpperCase()}${state.selected.kind.slice(1)}`
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
    ui.planWidthInput.disabled = !formEditable;
    ui.planHeightInput.disabled = !formEditable;
    ui.planVersionInput.disabled = !formEditable;
    ui.planActiveInput.disabled = !formEditable;

    document.querySelectorAll('[data-tool]').forEach(button => {
      if (EDIT_TOOLS.has(button.dataset.tool)) button.disabled = !state.canEdit;
    });
    document.getElementById('tool-delete').disabled = !state.canEdit;

    if (!state.canEdit && EDIT_TOOLS.has(state.tool)) setTool('select');
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
  }

  function updateAnchorSettings(entity) {
    const selectedAnchor = state.selected?.kind === 'anchor' ? entity : null;
    const placingAnchor = state.tool === 'anchor' && !selectedAnchor;
    ui.anchorSettings.hidden = !selectedAnchor && !placingAnchor;
    if (ui.anchorSettings.hidden) return;

    ui.anchorSettingsTitle.textContent = selectedAnchor ? 'Anchor properties' : 'Anchor placement defaults';
    ui.anchorIdInput.disabled = Boolean(selectedAnchor);
    ui.anchorIdInput.placeholder = `Auto: ${nextAnchorId()}`;
    ui.saveAnchorProperties.hidden = !selectedAnchor || !state.canEdit;

    if (!ui.anchorSettings.contains(document.activeElement)) {
      ui.anchorIdInput.value = selectedAnchor?.anchor_id || '';
      ui.anchorZInput.value = selectedAnchor?.z == null ? '' : String(selectedAnchor.z);
      ui.anchorMountInput.value = selectedAnchor?.mount_height_m == null
        ? '' : String(selectedAnchor.mount_height_m);
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

  function selectEntity(kind, id) {
    state.selected = kind ? { kind, id } : null;
    renderScene();
  }

  function setTool(tool) {
    if (EDIT_TOOLS.has(tool) && !state.canEdit) {
      setMessage('โหมดวาดต้องใช้สิทธิ์ admin', 'error');
      return;
    }
    state.tool = tool;
    if (tool === 'anchor') state.selected = null;
    state.draft = tool === 'zone' ? { kind: 'zone', points: [], cursor: null } : null;
    document.querySelectorAll('[data-tool]').forEach(button => {
      const active = button.dataset.tool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    ui.svg.dataset.tool = tool;
    const help = {
      select: 'Select: คลิกวัตถุเพื่อเลือก · ลาก object เพื่อย้าย',
      line: 'Line: ลากจากจุดเริ่มไปจุดปลาย',
      rectangle: 'Rectangle: ลากมุมตรงข้ามสองมุม',
      zone: 'Zone: คลิกอย่างน้อย 3 จุด แล้ว double click เพื่อจบ polygon',
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

  async function createObject(kind, start, end) {
    let geometry;
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
    }
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/objects`, {
        method: 'POST',
        body: JSON.stringify({ object_type: kind, geometry, properties: {} }),
      }),
      `${kind} บันทึกแล้ว`,
    );
    if (response?.object) {
      state.objects.push(response.object);
      selectEntity('object', response.object.object_id);
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
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/zones`, {
        method: 'POST',
        body: JSON.stringify({ name, geometry: geometryFromPoints('polygon', points) }),
      }),
      `${name} บันทึกแล้ว`,
    );
    if (response?.zone) {
      state.zones.push(response.zone);
      selectEntity('zone', response.zone.zone_id);
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
    let z;
    let mountHeight;
    try {
      anchorId = ui.anchorIdInput.value.trim() || nextAnchorId();
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
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/anchors`, {
        method: 'POST',
        body: JSON.stringify({
          anchor_id: anchorId,
          x: point.x,
          y: point.y,
          z,
          mount_height_m: mountHeight,
        }),
      }),
      `${anchorId} บันทึกแล้ว`,
    );
    if (response?.anchor) {
      state.anchors.push(response.anchor);
      ui.anchorIdInput.value = '';
      selectEntity('anchor', response.anchor.anchor_id);
    }
  }

  async function saveAnchorProperties() {
    const anchor = entityBySelection();
    if (!anchor || state.selected?.kind !== 'anchor') return;
    let z;
    let mountHeight;
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
          x: Number(anchor.x),
          y: Number(anchor.y),
          z,
          mount_height_m: mountHeight,
          battery: anchor.battery,
        }),
      }),
      `${anchor.anchor_id} properties บันทึกแล้ว`,
    );
    if (response?.anchor) {
      Object.assign(anchor, response.anchor);
      renderScene();
    }
  }

  async function createDimension(start, end) {
    const { length, angle } = measurement(start, end);
    const response = await safeMutation(
      () => api(`/api/plans/${encodeURIComponent(state.plan.plan_id)}/dimensions`, {
        method: 'POST',
        body: JSON.stringify({
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          length_m: length,
          angle_deg: angle,
        }),
      }),
      'Dimension บันทึกแล้ว',
    );
    if (response?.dimension) {
      state.dimensions.push(response.dimension);
      selectEntity('dimension', response.dimension.dimension_id);
    }
  }

  async function saveLineProperties() {
    const object = entityBySelection();
    const points = state.selected?.kind === 'object' ? linePoints(object) : [];
    if (!object || points.length !== 2 || !state.canEdit) return;

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
    if (response?.object) Object.assign(object, response.object);
    renderScene();
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
      const object = state.objects.find(item => String(item.object_id) === String(state.drag.id));
      if (object) object.geometry = state.drag.originalGeometry;
      state.drag = null;
    }
    state.pan = null;
    ui.svg.classList.remove('is-panning');
    state.draft = state.tool === 'zone' ? { kind: 'zone', points: [], cursor: null } : null;
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

  function onPointerDown(event) {
    if (!state.plan) return;
    ui.svg.focus({ preventScroll: true });
    if (event.button === 1 || (event.button === 0 && state.spaceDown)) {
      event.preventDefault();
      beginPan(event);
      return;
    }
    if (event.button !== 0) return;

    const point = pointerMetres(event, true);
    if (state.tool === 'select') {
      const target = event.target.closest?.('[data-kind]');
      if (!target) {
        selectEntity(null, null);
        return;
      }
      const kind = target.dataset.kind;
      const id = target.dataset.id;
      selectEntity(kind, id);
      if (kind === 'object' && state.canEdit) {
        const object = entityBySelection();
        state.drag = {
          id,
          start: point,
          originalGeometry: JSON.parse(JSON.stringify(object.geometry)),
        };
        ui.svg.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (!state.canEdit) return;
    if (state.tool === 'anchor') {
      void createAnchor(point);
      return;
    }
    if (state.tool === 'zone') {
      const points = state.draft?.points || [];
      const closeTolerance = metresPerPixel() * 12;
      if (points.length >= 3 && distance(point, points[0]) <= closeTolerance) {
        finishZone();
      } else {
        points.push(point);
        state.draft = { kind: 'zone', points, cursor: point };
        renderDraft();
      }
      return;
    }
    if (state.tool === 'dimension') {
      if (state.draft?.kind !== 'dimension' || !state.draft.start) {
        state.draft = { kind: 'dimension', start: point, end: point };
        setMessage(`Dimension start: X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)} m — คลิกจุดปลาย`);
        renderDraft();
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
    if (state.tool === 'line' || state.tool === 'rectangle') {
      state.draft = { kind: state.tool, start: point, end: point };
      ui.svg.setPointerCapture(event.pointerId);
      renderDraft();
    }
  }

  function onDoubleClick(event) {
    if (state.tool !== 'zone' || !state.canEdit || state.zoneNameOpen) return;
    event.preventDefault();
    finishZone();
  }

  function onPointerMove(event) {
    if (!state.plan) return;
    const raw = pointerMetres(event, false);
    const snapped = snapPoint(raw);
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

    if (state.drag) {
      const object = state.objects.find(item => String(item.object_id) === String(state.drag.id));
      if (!object) return;
      const dx = snapped.x - state.drag.start.x;
      const dy = snapped.y - state.drag.start.y;
      object.geometry = translatedGeometry(state.drag.originalGeometry, dx, dy);
      renderScene();
      return;
    }

    if (state.draft?.kind === 'zone') {
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
      void saveObjectDrag(drag);
      return;
    }
    const draft = state.draft;
    if (!draft?.start || !draft.end) return;
    if (draft.kind === 'dimension') return;
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
    document.getElementById('tool-fit').addEventListener('click', fitView);
    document.getElementById('tool-zoom-in').addEventListener('click', () => zoomAt(0.8));
    document.getElementById('tool-zoom-out').addEventListener('click', () => zoomAt(1.25));
    ui.saveAnchorProperties.addEventListener('click', () => void saveAnchorProperties());
    ui.saveLineProperties.addEventListener('click', () => void saveLineProperties());
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
    ui.svg.addEventListener('contextmenu', event => event.preventDefault());
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
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
        event.preventDefault();
        void deleteSelection();
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
    state.draft = null;
    state.drag = null;
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(planId)) {
      throw new Error('Plan ID ต้องใช้ตัวอักษร ตัวเลข จุด ขีดกลาง หรือ underscore และห้ามเว้นวรรค');
    }
    if (!name) throw new Error('กรุณาระบุชื่อแปลน');
    if (!Number.isFinite(width) || width <= 0) throw new Error('ความกว้างต้องมากกว่า 0 เมตร');
    if (!Number.isFinite(height) || height <= 0) throw new Error('ความสูงต้องมากกว่า 0 เมตร');
    if (!Number.isInteger(version) || version < 1) throw new Error('Version ต้องเป็นจำนวนเต็มตั้งแต่ 1');
    return {
      plan_id: planId,
      name,
      width_m: width,
      height_m: height,
      is_active: ui.planActiveInput.checked,
      version,
    };
  }

  async function savePlan() {
    if (!state.isAdmin || !state.editMode || !state.plan) return;
    let payload;
    try {
      payload = planPayloadFromForm();
    } catch (error) {
      setMessage(error.message, 'error');
      return;
    }

    const creating = state.isNewPlan;
    const projectId = state.plan.project_id;
    const endpoint = creating
      ? `/api/projects/${encodeURIComponent(projectId)}/plans`
      : `/api/plans/${encodeURIComponent(state.plan.plan_id)}`;
    const requestBody = creating ? payload : {
      name: payload.name,
      width_m: payload.width_m,
      height_m: payload.height_m,
      is_active: payload.is_active,
      version: payload.version,
    };
    const response = await safeMutation(
      () => api(endpoint, { method: creating ? 'POST' : 'PUT', body: JSON.stringify(requestBody) }),
      null,
    );
    if (!response?.plan) return;

    await loadProjects(projectId, response.plan.plan_id);
    await loadPlan(response.plan.plan_id);
    setMessage(creating ? 'สร้างแปลนและบันทึกลงฐานข้อมูลแล้ว' : 'บันทึกการแก้ไขแปลนแล้ว', 'ok');
  }

  async function loadPlan(planId) {
    if (!planId) {
      showLoading('ไม่พบ plan_id กรุณาระบุ Plan ID', true);
      return;
    }
    showLoading(`กำลังโหลด ${planId}...`);
    state.selected = null;
    state.draft = null;
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
