import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ALLOWED_ORIGINS = new Set([
  "https://amagelz.github.io",
  "https://jitmnaljkughkhmxeaov.supabase.co",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);
const WON = "ปิดการขาย";
const LOST = "ยกเลิกการขาย";
const DEAL_STATUSES = [WON, LOST];

type Profile = Record<string, any>;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://amagelz.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(req: Request, status: number, detail: string): Response {
  return json(req, { detail }, status);
}

function unwrap<T>(result: { data: T; error: any }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function isOnline(value: string | null | undefined, maxAgeSeconds: number): boolean {
  const valueEpoch = epoch(value);
  return valueEpoch !== null && Date.now() / 1000 - valueEpoch <= maxAgeSeconds;
}

function publicUser(profile: Profile): Profile {
  const {
    password_hash: _passwordHash,
    auth_user_id: _authUserId,
    ...safe
  } = profile;
  return safe;
}

async function authenticate(req: Request): Promise<Profile | null> {
  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return null;

  const result = await db
    .from("users")
    .select("*")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return result.data;
}

function requireRole(profile: Profile, roles: string[]): void {
  if (!roles.includes(profile.role)) throw new Response("Forbidden", { status: 403 });
}

async function body(req: Request): Promise<Record<string, any>> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function getPlans(projectId?: string): Promise<Profile[]> {
  let query = db.from("plans").select("*").order("is_active", { ascending: false }).order("name");
  if (projectId) query = query.eq("project_id", projectId);
  const rows = unwrap<any[]>(await query);
  return rows.map(({ id, ...row }) => ({ plan_id: id, ...row }));
}

async function getProjects(): Promise<Profile[]> {
  const projects = unwrap<any[]>(await db.from("projects").select("*").order("name"));
  const plans = await getPlans();
  return projects.map(({ id, ...project }) => ({
    project_id: id,
    ...project,
    plans: plans
      .filter((plan) => plan.project_id === id)
      .map((plan) => ({ plan_id: plan.plan_id, name: plan.name, live: plan.is_active })),
  }));
}

async function getAnchors(projectId?: string, planId?: string): Promise<Profile[]> {
  let query = db.from("anchors").select("*").order("anchor_id");
  if (projectId) query = query.eq("project_id", projectId);
  if (planId) query = query.eq("plan_id", planId);
  const rows = unwrap<any[]>(await query);
  return rows.map(({ id: _id, ...row }) => ({
    ...row,
    on: isOnline(row.last_ts, 30),
    last_ts: epoch(row.last_ts),
  }));
}

async function getTags(projectId?: string): Promise<Profile[]> {
  let query = db.from("tags").select("*").order("tag_id");
  if (projectId) query = query.eq("project_id", projectId);
  const [tags, users] = await Promise.all([
    query.then((result: any) => unwrap<any[]>(result)),
    db.from("users").select("employee_id,first_en,last_en").then((result: any) => unwrap<any[]>(result)),
  ]);
  const userByEmployee = new Map(users.map((user) => [user.employee_id, user]));
  return tags.map(({ id: _id, ...tag }) => {
    const user = userByEmployee.get(tag.employee_id);
    return {
      ...tag,
      sale_name: user ? `${user.first_en} ${user.last_en}`.trim() : null,
      on: isOnline(tag.last_ts, 5),
      last_ts: epoch(tag.last_ts),
    };
  });
}

async function getLive(rows = 400, since = 0): Promise<Profile> {
  const tags = await getTags();
  const tagMap = Object.fromEntries(tags.map((tag) => [tag.tag_id, {
    x: tag.x,
    y: tag.y,
    battery: tag.battery,
    on: tag.on,
    sale_name: tag.sale_name,
    last_ts: tag.last_ts,
  }]));

  let trail: any[] = [];
  if (rows > 0) {
    let query = db
      .from("positions")
      .select("tag_id,x,y,zone,ts")
      .order("ts", { ascending: false })
      .limit(Math.min(Math.max(rows, 1), 5000));
    if (since > 0) query = query.gt("ts", new Date(since * 1000).toISOString());
    trail = unwrap<any[]>(await query).map((position) => ({ ...position, ts: epoch(position.ts) }));
  }
  return { ok: true, now: Date.now() / 1000, tags: tagMap, rows: trail };
}

function visitFilters(url: URL, profile: Profile): Record<string, string> {
  const params: Record<string, string> = {};
  for (const key of ["province", "project", "plan", "employee", "customer", "from", "to"]) {
    const value = url.searchParams.get(key);
    if (value) params[key] = value;
  }
  if (profile.role === "sale") params.employee = profile.employee_id;
  return params;
}

async function getVisits(filters: Record<string, string>): Promise<Profile[]> {
  let query = db.from("visits").select("*").order("started_at", { ascending: false }).limit(400);
  if (filters.project) query = query.eq("project_id", filters.project);
  if (filters.plan) query = query.eq("plan_id", filters.plan);
  if (filters.employee) query = query.eq("employee_id", filters.employee);
  if (filters.customer) query = query.eq("customer_id", filters.customer);
  if (filters.from && Number.isFinite(Number(filters.from))) {
    query = query.gte("started_at", new Date(Number(filters.from) * 1000).toISOString());
  }
  if (filters.to && Number.isFinite(Number(filters.to))) {
    query = query.lte("started_at", new Date(Number(filters.to) * 1000).toISOString());
  }
  if (filters.province) {
    const projectRows = unwrap<any[]>(await db.from("projects").select("id").eq("province", filters.province));
    const ids = projectRows.map((project) => project.id);
    if (!ids.length) return [];
    query = query.in("project_id", ids);
  }

  const [rows, users, projects, customers] = await Promise.all([
    query.then((result: any) => unwrap<any[]>(result)),
    db.from("users").select("employee_id,first_en,last_en").then((result: any) => unwrap<any[]>(result)),
    db.from("projects").select("id,name").then((result: any) => unwrap<any[]>(result)),
    db.from("customers").select("id,name").then((result: any) => unwrap<any[]>(result)),
  ]);
  const userMap = new Map(users.map((item) => [item.employee_id, item]));
  const projectMap = new Map(projects.map((item) => [item.id, item.name]));
  const customerMap = new Map(customers.map((item) => [item.id, item.name]));

  return rows.map((row) => {
    const user = userMap.get(row.employee_id);
    const { started_at, ended_at, duration_sec, zone, ...rest } = row;
    return {
      ...rest,
      sale_name: user ? `${user.first_en} ${user.last_en}`.trim() : null,
      project_name: projectMap.get(row.project_id) ?? null,
      customer_name: customerMap.get(row.customer_id) ?? null,
      start_ts: epoch(started_at),
      end_ts: epoch(ended_at),
      duration: duration_sec,
      top_zone: zone,
    };
  });
}

async function getVisitDetail(visitKey: string, profile: Profile): Promise<Profile | null> {
  const visit = unwrap<any>(await db.from("visits").select("*").eq("visit_key", visitKey).maybeSingle());
  if (!visit) return null;
  if (profile.role === "sale" && visit.employee_id !== profile.employee_id) return null;

  const end = visit.ended_at ?? new Date().toISOString();
  const [positions, notes, users, projects, customers] = await Promise.all([
    db.from("positions").select("x,y,zone,ts").eq("tag_id", visit.tag_id)
      .gte("ts", visit.started_at).lte("ts", end).order("ts").limit(5000)
      .then((result: any) => unwrap<any[]>(result)),
    db.from("notes").select("body,created_at,user_id").eq("visit_key", visitKey)
      .order("created_at", { ascending: false }).then((result: any) => unwrap<any[]>(result)),
    db.from("users").select("id,employee_id,first_en,last_en").then((result: any) => unwrap<any[]>(result)),
    db.from("projects").select("id,name").then((result: any) => unwrap<any[]>(result)),
    db.from("customers").select("id,name").then((result: any) => unwrap<any[]>(result)),
  ]);
  const usersById = new Map(users.map((item) => [item.id, item]));
  const sale = users.find((item) => item.employee_id === visit.employee_id);
  const timeline = positions.map((item) => ({ ts: epoch(item.ts), zone: item.zone || "outside" }));
  const dwellMap = new Map<string, { seconds: number; first_ts: number | null }>();
  let dropped = 0;
  for (let index = 1; index < positions.length; index++) {
    const previous = positions[index - 1];
    const gap = (epoch(positions[index].ts)! - epoch(previous.ts)!);
    if (gap <= 0) continue;
    if (gap > 5) { dropped += gap; continue; }
    const zone = previous.zone || "outside";
    const item = dwellMap.get(zone) ?? { seconds: 0, first_ts: epoch(previous.ts) };
    item.seconds += gap;
    dwellMap.set(zone, item);
  }
  const total = [...dwellMap.values()].reduce((sum, item) => sum + item.seconds, 0) || 1;
  const dwell = [...dwellMap.entries()]
    .map(([zone, item]) => ({
      zone,
      first_ts: item.first_ts,
      seconds: Math.round(item.seconds * 10) / 10,
      pct: Math.round(1000 * item.seconds / total) / 10,
    }))
    .sort((a, b) => b.seconds - a.seconds);
  let path = positions.map((item) => [item.x, item.y]);
  if (path.length > 400) path = path.filter((_item, index) => index % (Math.floor(path.length / 400) + 1) === 0);

  const { started_at, ended_at, duration_sec, zone, ...rest } = visit;
  return {
    ...rest,
    sale_name: sale ? `${sale.first_en} ${sale.last_en}`.trim() : null,
    project_name: projects.find((item) => item.id === visit.project_id)?.name ?? null,
    customer_name: customers.find((item) => item.id === visit.customer_id)?.name ?? null,
    start_ts: epoch(started_at),
    end_ts: epoch(ended_at),
    duration: duration_sec,
    top_zone: zone,
    fixes: positions.length,
    timeline,
    dwell,
    dwell_dropped: Math.round(dropped * 10) / 10,
    path,
    notes: notes.map((note) => {
      const author = usersById.get(note.user_id);
      return {
        body: note.body,
        created_at: epoch(note.created_at),
        author: author ? `${author.first_en} ${author.last_en}`.trim() : note.user_id,
      };
    }),
    viewer_role: profile.role,
    can_edit: ["admin", "sale_lead"].includes(profile.role),
  };
}

function overview(visits: Profile[], anchors: Profile[], tags: Profile[], scope: string): Profile {
  const durations = visits.map((item) => item.duration).filter((value) => value !== null && value !== undefined);
  const decided = visits.filter((item) => DEAL_STATUSES.includes(item.deal_status));
  const won = decided.filter((item) => item.deal_status === WON);
  return {
    ok: true,
    visits: visits.length,
    anchors_on: anchors.filter((item) => item.on).length,
    anchors_total: anchors.length,
    tags_on: tags.filter((item) => item.on).length,
    tags_total: tags.length,
    avg_duration: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
    close_rate: decided.length ? 100 * won.length / decided.length : null,
    scope,
  };
}

function heatmap(visits: Profile[]): Profile {
  const buckets = new Map<string, number>();
  for (const visit of visits) {
    if (!visit.start_ts) continue;
    const key = new Date(visit.start_ts * 1000).toISOString().slice(0, 13);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const rows = [...buckets.entries()].sort().map(([bucket, count]) => ({ bucket, visits: count }));
  return { ok: true, rows, peak: Math.max(1, ...rows.map((item) => item.visits)) };
}

function analytics(visits: Profile[]): Profile {
  const decided = visits.filter((item) => DEAL_STATUSES.includes(item.deal_status));
  const won = decided.filter((item) => item.deal_status === WON);
  const lost = decided.filter((item) => item.deal_status === LOST);
  const durations = visits.map((item) => item.duration).filter((value) => value !== null && value !== undefined);
  const average = (items: Profile[]) => {
    const values = items.map((item) => item.duration).filter((value) => value !== null && value !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const funnel = [
    { label: "การเยี่ยมชมทั้งหมด", n: visits.length },
    { label: "บันทึกรหัสลูกค้าแล้ว", n: visits.filter((item) => item.customer_id).length },
    { label: "ระบุผลการขายแล้ว", n: decided.length },
    { label: "ปิดการขายได้", n: won.length },
  ];
  const zoneBuckets = new Map<string, { won: number[]; lost: number[] }>();
  for (const visit of decided) {
    const zone = visit.top_zone || "ไม่ระบุโซน";
    const bucket = zoneBuckets.get(zone) ?? { won: [], lost: [] };
    bucket[visit.deal_status === WON ? "won" : "lost"].push(visit.duration || 0);
    zoneBuckets.set(zone, bucket);
  }
  const avgValues = (items: number[]) => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : null;
  const zone_by_outcome = [...zoneBuckets.entries()].map(([zone, bucket]) => {
    const wonAvg = avgValues(bucket.won);
    const lostAvg = avgValues(bucket.lost);
    return {
      zone,
      won_avg: wonAvg,
      lost_avg: lostAvg,
      delta: wonAvg !== null && lostAvg !== null ? wonAvg - lostAvg : null,
      total: bucket.won.length + bucket.lost.length,
    };
  }).sort((a, b) => b.total - a.total).slice(0, 6);
  const people = new Map<string, any>();
  for (const visit of visits) {
    const id = visit.employee_id || "—";
    const item = people.get(id) ?? { employee_id: id, name: visit.sale_name || id, visits: 0, decided: 0, won: 0, durations: [] };
    item.visits++;
    if (visit.duration !== null && visit.duration !== undefined) item.durations.push(visit.duration);
    if (DEAL_STATUSES.includes(visit.deal_status)) {
      item.decided++;
      if (visit.deal_status === WON) item.won++;
    }
    people.set(id, item);
  }
  const by_person = [...people.values()].map((item) => ({
    employee_id: item.employee_id,
    name: item.name,
    visits: item.visits,
    decided: item.decided,
    won: item.won,
    avg_duration: item.durations.length ? item.durations.reduce((a: number, b: number) => a + b, 0) / item.durations.length : null,
    close_rate: item.decided ? 100 * item.won / item.decided : null,
  })).sort((a, b) => b.visits - a.visits);
  const by_hour = Array.from({ length: 24 }, (_, hour) => ({ hour, visits: 0 }));
  const by_weekday = Array.from({ length: 7 }, (_, day) => ({ day, visits: 0 }));
  for (const visit of visits) {
    if (!visit.start_ts) continue;
    const date = new Date(visit.start_ts * 1000);
    by_hour[date.getUTCHours()].visits++;
    by_weekday[(date.getUTCDay() + 6) % 7].visits++;
  }
  return {
    ok: true,
    n_visits: visits.length,
    decided: decided.length,
    won: won.length,
    lost: lost.length,
    unlabelled: visits.length - decided.length,
    close_rate: decided.length ? 100 * won.length / decided.length : null,
    avg_duration: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
    enough_data: decided.length >= 10,
    min_for_trend: 10,
    funnel,
    duration_by_outcome: {
      won: { n: won.length, avg: average(won) },
      lost: { n: lost.length, avg: average(lost) },
    },
    zone_by_outcome,
    by_person,
    by_hour,
    by_weekday,
  };
}

function coverage(payload: Profile): Profile {
  const anchors = payload.anchors || [];
  const radius = Math.max(Number(payload.coverage_radius_m || 10), 0.1);
  const width = Math.max(Number(payload.width_m || 20), 0.1);
  const height = Math.max(Number(payload.height_m || 20), 0.1);
  const resolution = Math.max(Number(payload.resolution_m || Math.max(Math.min(width, height) / 80, 0.25)), 0.1);
  const nx = Math.min(160, Math.max(2, Math.floor(width / resolution) + 1));
  const ny = Math.min(160, Math.max(2, Math.floor(height / resolution) + 1));
  let ok = 0, weak = 0, none = 0;
  const gap_points: Profile[] = [];
  for (let ix = 0; ix < nx; ix++) {
    const x = width * ix / (nx - 1);
    for (let iy = 0; iy < ny; iy++) {
      const y = height * iy / (ny - 1);
      const count = anchors.filter((anchor: Profile) => Math.hypot(anchor.x - x, anchor.y - y) <= radius).length;
      if (count >= 3) ok++;
      else {
        if (count) weak++; else none++;
        if (gap_points.length < 200) gap_points.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, anchors_in_range: count });
      }
    }
  }
  const total = nx * ny;
  return {
    grid_resolution_m: Math.round(resolution * 1000) / 1000,
    grid_points: total,
    trilateration_ok_pct: Math.round(1000 * ok / total) / 10,
    weak_coverage_pct: Math.round(1000 * weak / total) / 10,
    no_signal_pct: Math.round(1000 * none / total) / 10,
    gap_points,
    gap_points_truncated: weak + none > gap_points.length,
  };
}

function suggestedAnchors(payload: Profile): Profile[] {
  const width = Math.max(Number(payload.width_m || 20), 1);
  const height = Math.max(Number(payload.height_m || 20), 1);
  const margin = Math.max(Number(payload.margin_m || 1), 0);
  const radius = Math.max(Number(payload.coverage_radius_m || 12), 1);
  const innerWidth = Math.max(width - 2 * margin, 0.1);
  const innerHeight = Math.max(height - 2 * margin, 0.1);
  const spacing = Math.max(radius * 1.2, 2);
  const nx = Math.max(2, Math.ceil(innerWidth / spacing) + 1);
  const ny = Math.max(2, Math.ceil(innerHeight / spacing) + 1);
  const anchors: Profile[] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      anchors.push({
        anchor_id: `A${String(anchors.length + 1).padStart(2, "0")}`,
        x: Math.round((margin + innerWidth * x / (nx - 1)) * 100) / 100,
        y: Math.round((margin + innerHeight * y / (ny - 1)) * 100) / 100,
      });
    }
  }
  return anchors;
}

function normaliseDimension(payload: Profile): Profile {
  const x1 = Number(payload.x1), y1 = Number(payload.y1), x2 = Number(payload.x2), y2 = Number(payload.y2);
  return {
    x1, y1, x2, y2,
    length_m: Math.hypot(x2 - x1, y2 - y1),
    angle_deg: Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI,
    label: payload.label ?? null,
  };
}

function polygonBounds(geometry: Profile): Profile {
  const points = Array.isArray(geometry?.points) ? geometry.points : [];
  if (points.length < 3) throw new Error("Zone polygon requires at least 3 points");
  const xs = points.map((point: number[]) => Number(point[0]));
  const ys = points.map((point: number[]) => Number(point[1]));
  return { x_min: Math.min(...xs), x_max: Math.max(...xs), y_min: Math.min(...ys), y_max: Math.max(...ys) };
}

async function route(req: Request, profile: Profile): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path.startsWith("/functions/v1/api")) {
    path = path.slice("/functions/v1/api".length) || "/";
  } else if (path.startsWith("/api/api/")) {
    path = path.slice("/api".length);
  }
  const method = req.method.toUpperCase();

  if (path === "/health" && method === "GET") {
    return json(req, { ok: true, service: "supalai-supabase-edge-api", time: new Date().toISOString() });
  }
  if (path === "/api/me" && method === "GET") return json(req, { ok: true, user: publicUser(profile) });
  if (path === "/api/signout" && method === "POST") return json(req, { ok: true });

  if (path === "/api/bootstrap" && method === "GET") {
    const [projects, people, customers] = await Promise.all([
      getProjects(),
      db.from("users").select("employee_id,first_en,last_en,first_th,last_th,role,position,tag_id").order("employee_id")
        .then((result: any) => unwrap<any[]>(result)),
      db.from("customers").select("id,name").order("name").then((result: any) => unwrap<any[]>(result)),
    ]);
    let liveProjectId: string | null = projects[0]?.project_id ?? null;
    for (const project of projects) {
      if ((await getAnchors(project.project_id)).length) { liveProjectId = project.project_id; break; }
    }
    const [zones, anchors] = liveProjectId ? await Promise.all([
      db.from("zones").select("name,x_min,x_max,y_min,y_max").eq("project_id", liveProjectId).order("id")
        .then((result: any) => unwrap<any[]>(result)),
      getAnchors(liveProjectId),
    ]) : [[], []];
    return json(req, {
      ok: true,
      user: publicUser(profile),
      projects,
      people,
      customers,
      zones: zones.map((zone: Profile) => ({ name: zone.name, x: [zone.x_min, zone.x_max], y: [zone.y_min, zone.y_max] })),
      anchors: Object.fromEntries(anchors.map((anchor) => [anchor.anchor_id, [anchor.x, anchor.y]])),
      live_project_id: liveProjectId,
      deal_statuses: DEAL_STATUSES,
    });
  }

  if (path === "/api/devices" && method === "GET") {
    const [anchors, tags] = await Promise.all([getAnchors(), getTags()]);
    return json(req, { ok: true, anchors, tags });
  }
  if (path === "/api/live" && method === "GET") {
    return json(req, await getLive(Number(url.searchParams.get("rows") ?? 400), Number(url.searchParams.get("since") ?? 0)));
  }
  if (path === "/api/visits" && method === "GET") {
    const filters = visitFilters(url, profile);
    return json(req, { ok: true, visits: await getVisits(filters), scope: profile.role === "sale" ? "sale" : "all" });
  }
  if (path === "/api/visit" && method === "GET") {
    const detail = await getVisitDetail(url.searchParams.get("key") ?? "", profile);
    return detail ? json(req, detail) : fail(req, 404, "ไม่พบข้อมูลการเยี่ยมชม หรือไม่มีสิทธิ์เข้าถึง");
  }
  if (path === "/api/overview" && method === "GET") {
    const [visits, anchors, tags] = await Promise.all([
      getVisits(visitFilters(url, profile)), getAnchors(), getTags(),
    ]);
    return json(req, overview(visits, anchors, tags, profile.role === "sale" ? "sale" : "all"));
  }
  if (path === "/api/heatmap" && method === "GET") return json(req, heatmap(await getVisits(visitFilters(url, profile))));
  if (path === "/api/analytics" && method === "GET") {
    requireRole(profile, ["admin", "sale_lead"]);
    return json(req, analytics(await getVisits(visitFilters(url, profile))));
  }
  if (path === "/api/visit-meta" && method === "POST") {
    requireRole(profile, ["admin", "sale_lead"]);
    const payload = await body(req);
    unwrap(await db.from("visits").update({ customer_id: payload.customer_id, deal_status: payload.deal_status }).eq("visit_key", payload.visit_key));
    return json(req, { ok: true });
  }
  if (path === "/api/note" && method === "POST") {
    const payload = await body(req);
    const visit = unwrap<any>(await db.from("visits").select("employee_id").eq("visit_key", payload.visit_key).maybeSingle());
    if (!visit) return fail(req, 404, "ไม่พบ visit");
    if (profile.role === "sale" && visit.employee_id !== profile.employee_id) return fail(req, 403, "ไม่มีสิทธิ์แก้ไขข้อมูลนี้");
    unwrap(await db.from("notes").insert({ visit_key: payload.visit_key, user_id: profile.id, body: String(payload.body || "").trim() }));
    return json(req, { ok: true });
  }

  if (path === "/api/projects" && method === "GET") return json(req, { ok: true, projects: await getProjects() });
  if (path === "/api/projects" && method === "POST") {
    requireRole(profile, ["admin"]);
    const payload = await body(req);
    unwrap(await db.from("projects").insert({
      id: payload.project_id, name: payload.name, province: payload.province || "",
      plan_id: payload.plan_id || "", plan_name: payload.plan_name || "",
      width_m: payload.width_m || 20, height_m: payload.height_m || 20,
    }));
    return json(req, { ok: true, project: (await getProjects()).find((item) => item.project_id === payload.project_id) });
  }

  let match = path.match(/^\/api\/projects\/([^/]+)$/);
  if (match && method === "GET") {
    const projectId = decodeURIComponent(match[1]);
    const project = (await getProjects()).find((item) => item.project_id === projectId);
    if (!project) return fail(req, 404, "ไม่พบโครงการ");
    return json(req, { ...project, anchors: await getAnchors(projectId), zones: unwrap(await db.from("zones").select("name,x_min,x_max,y_min,y_max").eq("project_id", projectId).order("id")) });
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/plans$/);
  if (match && method === "GET") return json(req, { ok: true, plans: await getPlans(decodeURIComponent(match[1])) });
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const inserted = unwrap<any>(await db.from("plans").insert({
      id: payload.plan_id, project_id: projectId, name: payload.name,
      width_m: payload.width_m, height_m: payload.height_m,
      is_active: Boolean(payload.is_active), version: payload.version || 1,
    }).select().single());
    if (inserted.is_active) {
      await db.from("plans").update({ is_active: false }).eq("project_id", projectId).neq("id", inserted.id);
      await db.from("projects").update({ plan_id: inserted.id, plan_name: inserted.name, width_m: inserted.width_m, height_m: inserted.height_m }).eq("id", projectId);
    }
    const { id, ...rest } = inserted;
    return json(req, { ok: true, plan: { plan_id: id, ...rest } });
  }

  match = path.match(/^\/api\/plans\/([^/]+)$/);
  if (match && method === "GET") {
    const plan = unwrap<any>(await db.from("plans").select("*").eq("id", decodeURIComponent(match[1])).maybeSingle());
    if (!plan) return fail(req, 404, "ไม่พบแปลน");
    const { id, ...rest } = plan;
    return json(req, { ok: true, plan: { plan_id: id, ...rest } });
  }
  if (match && method === "PUT") {
    requireRole(profile, ["admin"]);
    const planId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const allowed = Object.fromEntries(Object.entries(payload).filter(([key]) => ["name", "width_m", "height_m", "is_active", "version"].includes(key)));
    const updated = unwrap<any>(await db.from("plans").update({ ...allowed, updated_at: new Date().toISOString() }).eq("id", planId).select().single());
    if (updated.is_active) {
      await db.from("plans").update({ is_active: false }).eq("project_id", updated.project_id).neq("id", planId);
      await db.from("projects").update({ plan_id: planId, plan_name: updated.name, width_m: updated.width_m, height_m: updated.height_m }).eq("id", updated.project_id);
    }
    const { id, ...rest } = updated;
    return json(req, { ok: true, plan: { plan_id: id, ...rest } });
  }

  match = path.match(/^\/api\/plans\/([^/]+)\/objects(?:\/([0-9]+))?$/);
  if (match && method === "GET" && !match[2]) {
    const rows = unwrap<any[]>(await db.from("plan_objects").select("*").eq("plan_id", decodeURIComponent(match[1])).order("id"));
    return json(req, { ok: true, objects: rows.map(({ id, ...row }) => ({ object_id: id, ...row })) });
  }
  if (match && method === "POST" && !match[2]) {
    requireRole(profile, ["admin"]);
    const payload = await body(req);
    const row = unwrap<any>(await db.from("plan_objects").insert({ plan_id: decodeURIComponent(match[1]), object_type: payload.object_type, label: payload.label ?? null, geometry: payload.geometry, properties: payload.properties || {} }).select().single());
    const { id, ...rest } = row;
    return json(req, { ok: true, object: { object_id: id, ...rest } });
  }
  if (match && method === "PUT" && match[2]) {
    requireRole(profile, ["admin"]);
    const payload = await body(req);
    const allowed = Object.fromEntries(Object.entries(payload).filter(([key]) => ["object_type", "label", "geometry", "properties"].includes(key)));
    const row = unwrap<any>(await db.from("plan_objects").update({ ...allowed, updated_at: new Date().toISOString() }).eq("plan_id", decodeURIComponent(match[1])).eq("id", Number(match[2])).select().single());
    const { id, ...rest } = row;
    return json(req, { ok: true, object: { object_id: id, ...rest } });
  }
  if (match && method === "DELETE" && match[2]) {
    requireRole(profile, ["admin"]);
    unwrap(await db.from("plan_objects").delete().eq("plan_id", decodeURIComponent(match[1])).eq("id", Number(match[2])));
    return json(req, { ok: true });
  }

  match = path.match(/^\/api\/plans\/([^/]+)\/zones$/);
  if (match && method === "GET") {
    const rows = unwrap<any[]>(await db.from("zones").select("*").eq("plan_id", decodeURIComponent(match[1])).order("id"));
    return json(req, { ok: true, zones: rows.map(({ id, ...row }) => ({ zone_id: id, ...row })) });
  }
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const planId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const plan = unwrap<any>(await db.from("plans").select("project_id").eq("id", planId).single());
    const geometry = payload.geometry || { type: "polygon", points: payload.points };
    const row = unwrap<any>(await db.from("zones").insert({ project_id: plan.project_id, plan_id: planId, name: payload.name, ...polygonBounds(geometry), geometry }).select().single());
    const { id, ...rest } = row;
    return json(req, { ok: true, zone: { zone_id: id, ...rest } });
  }

  match = path.match(/^\/api\/plans\/([^/]+)\/anchors$/);
  if (match && method === "GET") return json(req, { ok: true, anchors: await getAnchors(undefined, decodeURIComponent(match[1])) });
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const planId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const plan = unwrap<any>(await db.from("plans").select("project_id").eq("id", planId).single());
    unwrap(await db.from("anchors").upsert({ project_id: plan.project_id, plan_id: planId, anchor_id: payload.anchor_id, x: payload.x, y: payload.y, z: payload.z ?? null, mount_height_m: payload.mount_height_m ?? null, battery: payload.battery ?? null, last_ts: new Date().toISOString() }, { onConflict: "project_id,anchor_id" }));
    return json(req, { ok: true, anchor: (await getAnchors(undefined, planId)).find((item) => item.anchor_id === payload.anchor_id) });
  }

  match = path.match(/^\/api\/plans\/([^/]+)\/dimensions$/);
  if (match && method === "GET") {
    const rows = unwrap<any[]>(await db.from("plan_dimensions").select("*").eq("plan_id", decodeURIComponent(match[1])).order("id"));
    return json(req, { ok: true, dimensions: rows.map(({ id, ...row }) => ({ dimension_id: id, ...row })) });
  }
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const row = unwrap<any>(await db.from("plan_dimensions").insert({ plan_id: decodeURIComponent(match[1]), ...normaliseDimension(await body(req)) }).select().single());
    const { id, ...rest } = row;
    return json(req, { ok: true, dimension: { dimension_id: id, ...rest } });
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/anchors$/);
  if (match && method === "GET") return json(req, { ok: true, anchors: await getAnchors(decodeURIComponent(match[1])) });
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    unwrap(await db.from("anchors").upsert({ project_id: projectId, anchor_id: payload.anchor_id, x: payload.x, y: payload.y, battery: payload.battery ?? null, last_ts: new Date().toISOString() }, { onConflict: "project_id,anchor_id" }));
    return json(req, { ok: true, anchor: (await getAnchors(projectId)).find((item) => item.anchor_id === payload.anchor_id) });
  }

  if (path === "/api/calculation/anchors" && method === "POST") {
    const payload = await body(req);
    const anchors = suggestedAnchors(payload);
    return json(req, { ok: true, input: payload, suggested_anchors: anchors, predicted_coverage: coverage({ ...payload, anchors }) });
  }
  if (path === "/api/calculation/coverage" && method === "POST") {
    const payload = await body(req);
    if (!payload.anchors?.length) return fail(req, 400, "ต้องระบุตำแหน่ง anchor อย่างน้อย 1 จุด");
    return json(req, { ok: true, coverage_radius_m: Number(payload.coverage_radius_m || 10), anchors: payload.anchors, ...coverage(payload) });
  }

  match = path.match(/^\/api\/positioning\/([^/]+)$/);
  if (match && method === "GET") {
    const live = await getLive(0);
    return json(req, { ok: true, project_id: decodeURIComponent(match[1]), tags: live.tags });
  }
  if (match && method === "POST") {
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const anchors = await getAnchors(projectId);
    const anchorMap = new Map(anchors.map((anchor) => [anchor.anchor_id, anchor]));
    const known = (payload.ranges || []).map((range: Profile) => ({ anchor: anchorMap.get(range.anchor_id), distance: Number(range.distance_m) })).filter((item: any) => item.anchor && item.distance > 0);
    if (known.length < 3) return fail(req, 400, "ต้องมีระยะจาก anchor ที่รู้จักอย่างน้อย 3 จุด");
    const reference = known[known.length - 1];
    let aa = 0, ab = 0, bb = 0, ac = 0, bc = 0;
    for (const item of known.slice(0, -1)) {
      const a = 2 * (reference.anchor.x - item.anchor.x);
      const b = 2 * (reference.anchor.y - item.anchor.y);
      const c = item.distance ** 2 - reference.distance ** 2 - item.anchor.x ** 2 - item.anchor.y ** 2 + reference.anchor.x ** 2 + reference.anchor.y ** 2;
      aa += a * a; ab += a * b; bb += b * b; ac += a * c; bc += b * c;
    }
    const determinant = aa * bb - ab * ab;
    if (Math.abs(determinant) < 1e-9) return fail(req, 422, "คำนวณตำแหน่งไม่สำเร็จ");
    const x = (ac * bb - bc * ab) / determinant;
    const y = (bc * aa - ac * ab) / determinant;
    const residual = Math.sqrt(known.reduce((sum: number, item: any) => sum + (Math.hypot(item.anchor.x - x, item.anchor.y - y) - item.distance) ** 2, 0) / known.length);
    const zones = unwrap<any[]>(await db.from("zones").select("name,x_min,x_max,y_min,y_max").eq("project_id", projectId));
    const zone = zones.find((item) => item.x_min <= x && x <= item.x_max && item.y_min <= y && y <= item.y_max)?.name ?? null;
    const now = new Date().toISOString();
    const tag = unwrap<any>(await db.from("tags").select("*").eq("tag_id", payload.tag_id).maybeSingle());
    if (!tag) return fail(req, 404, "ไม่พบ tag");
    unwrap(await db.from("positions").insert({ tag_id: payload.tag_id, x, y, zone, ts: now }));
    unwrap(await db.from("tags").update({ x, y, last_ts: now }).eq("tag_id", payload.tag_id));
    const openVisit = unwrap<any>(await db.from("visits").select("visit_key").eq("tag_id", payload.tag_id).is("ended_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle());
    if (!openVisit) {
      const project = unwrap<any>(await db.from("projects").select("plan_id").eq("id", projectId).single());
      const visitKey = `V-${Math.floor(Date.now() / 1000)}-${payload.tag_id}-${crypto.randomUUID().slice(0, 6)}`;
      unwrap(await db.from("visits").insert({ visit_key: visitKey, tag_id: payload.tag_id, employee_id: tag.employee_id, project_id: projectId, plan_id: project.plan_id, started_at: now, deal_status: "" }));
    }
    return json(req, { ok: true, tag_id: payload.tag_id, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, zone, residual_m: Math.round(residual * 10000) / 10000, anchors_used: known.length, ts: Date.now() / 1000 });
  }

  return fail(req, 404, `Unknown endpoint: ${method} ${path}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return fail(req, 403, "Origin not allowed");

  try {
    const profile = await authenticate(req);
    if (!profile) return fail(req, 401, "Supabase session is missing or expired");
    return await route(req, profile);
  } catch (error) {
    if (error instanceof Response) return fail(req, error.status, error.status === 403 ? "ไม่มีสิทธิ์ดำเนินการ" : error.statusText);
    console.error(error);
    return fail(req, 500, error instanceof Error ? error.message : "Internal server error");
  }
});
