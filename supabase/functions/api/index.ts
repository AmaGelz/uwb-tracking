import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ALLOWED_ORIGINS = new Set([
  "https://supalai-uwb-tracking.ordinary-plant.workers.dev",
  "https://jitmnaljkughkhmxeaov.supabase.co",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);
const WON = "ปิดการขาย";
const LOST = "ยกเลิกการขาย";
const DEAL_STATUSES = [WON, LOST];

type Profile = Record<string, any>;

const TAG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const HARDWARE_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TAG_TYPES = new Set(["physical", "mock"]);
const TAG_STATUSES = new Set(["active", "disabled"]);
const TRACKING_MODES = new Set(["hardware", "simulation", "disabled"]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://supalai-uwb-tracking.ordinary-plant.workers.dev",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
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
  if (result.error) {
    const error: any = new Error(result.error.message);
    error.code = result.error.code;
    error.details = result.error.details;
    throw error;
  }
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

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function cleanIdentifier(value: unknown, field: string, pattern = TAG_ID_PATTERN): string {
  const result = String(value ?? "").trim();
  if (!pattern.test(result)) throw new HttpError(422, `${field} is invalid`);
  return result;
}

function cleanNullableText(value: unknown, maxLength = 200): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  if (!result) return null;
  if (result.length > maxLength) throw new HttpError(422, `Value must not exceed ${maxLength} characters`);
  return result;
}

function randomGatewayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function projectForAssignment(projectId: string, tagType: string): Promise<Profile> {
  const project = unwrap<any>(await db
    .from("projects")
    .select("id,name,tracking_mode")
    .eq("id", projectId)
    .maybeSingle());
  if (!project) throw new HttpError(404, "Project not found");
  if (project.tracking_mode === "disabled") throw new HttpError(409, "Tracking is disabled for this project");
  if (tagType === "physical" && project.tracking_mode !== "hardware") {
    project.tracking_mode = "hardware";
    unwrap(await db.from("projects").update({ tracking_mode: "hardware" }).eq("id", projectId));
  }
  if (tagType === "mock" && project.tracking_mode === "hardware") {
    throw new HttpError(409, "Mock tags cannot be assigned to a hardware project");
  }
  return project;
}

async function employeeExists(employeeId: string | null): Promise<void> {
  if (!employeeId) return;
  const employee = unwrap<any>(await db
    .from("users")
    .select("employee_id")
    .eq("employee_id", employeeId)
    .maybeSingle());
  if (!employee) throw new HttpError(404, "Employee not found");
}

async function closeOpenVisits(tagId: string, endedAt: string): Promise<void> {
  const visits = unwrap<any[]>(await db
    .from("visits")
    .select("visit_key,started_at")
    .eq("tag_id", tagId)
    .is("ended_at", null));
  for (const visit of visits) {
    const start = Date.parse(visit.started_at);
    const end = Date.parse(endedAt);
    const duration = Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, Math.round((end - start) / 1000))
      : 0;
    unwrap(await db.from("visits").update({ ended_at: endedAt, duration_sec: duration }).eq("visit_key", visit.visit_key));
  }
}

async function syncLegacyUserTag(tagId: string, employeeId: string | null): Promise<void> {
  unwrap(await db.from("users").update({ tag_id: null }).eq("tag_id", tagId));
  if (employeeId) unwrap(await db.from("users").update({ tag_id: tagId }).eq("employee_id", employeeId));
}

async function assignTag(
  tagId: string,
  projectId: string,
  employeeId: string | null,
  assignedBy: string,
): Promise<Profile> {
  const tag = unwrap<any>(await db.from("tags").select("*").eq("tag_id", tagId).maybeSingle());
  if (!tag) throw new HttpError(404, "Tag not found");
  await Promise.all([projectForAssignment(projectId, tag.tag_type), employeeExists(employeeId)]);

  const current = unwrap<any>(await db
    .from("tag_assignments")
    .select("id,project_id,employee_id,assigned_at")
    .eq("tag_id", tagId)
    .is("ended_at", null)
    .maybeSingle());
  if (current?.project_id === projectId && (current.employee_id ?? null) === employeeId) return current;

  const now = new Date().toISOString();
  await closeOpenVisits(tagId, now);
  unwrap(await db.from("tag_assignments").update({ ended_at: now }).eq("tag_id", tagId).is("ended_at", null));
  const assignment = unwrap<any>(await db.from("tag_assignments").insert({
    tag_id: tagId,
    project_id: projectId,
    employee_id: employeeId,
    assigned_at: now,
    assigned_by: assignedBy,
  }).select().single());
  unwrap(await db.from("tags").update({
    project_id: projectId,
    employee_id: employeeId,
    x: null,
    y: null,
    last_ts: null,
    updated_at: now,
  }).eq("tag_id", tagId));
  await syncLegacyUserTag(tagId, employeeId);
  return assignment;
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

async function syncProjectPlan(projectId: string): Promise<void> {
  const plan = unwrap<any>(await db
    .from("plans")
    .select("id,name,width_m,height_m,is_active,updated_at")
    .eq("project_id", projectId)
    .order("is_active", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle());
  if (!plan) return;
  unwrap(await db.from("projects").update({
    plan_id: plan.id,
    plan_name: plan.name,
    width_m: plan.width_m,
    height_m: plan.height_m,
  }).eq("id", projectId));
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
  let assignmentQuery = db
    .from("tag_assignments")
    .select("id,tag_id,project_id,employee_id,assigned_at")
    .is("ended_at", null);
  if (projectId) assignmentQuery = assignmentQuery.eq("project_id", projectId);
  const [tags, users, assignments] = await Promise.all([
    query.then((result: any) => unwrap<any[]>(result)),
    db.from("users").select("employee_id,first_en,last_en").then((result: any) => unwrap<any[]>(result)),
    assignmentQuery.then((result: any) => unwrap<any[]>(result)),
  ]);
  const userByEmployee = new Map(users.map((user) => [user.employee_id, user]));
  const assignmentByTag = new Map(assignments.map((assignment) => [assignment.tag_id, assignment]));
  return tags.map(({ id: _id, ...tag }) => {
    const assignment = assignmentByTag.get(tag.tag_id);
    const employeeId = assignment?.employee_id ?? tag.employee_id ?? null;
    const effectiveProjectId = assignment?.project_id ?? tag.project_id ?? null;
    const user = userByEmployee.get(employeeId);
    const on = tag.status === "active" && isOnline(tag.last_ts, 5);
    return {
      ...tag,
      project_id: effectiveProjectId,
      employee_id: employeeId,
      assignment_id: assignment?.id ?? null,
      assigned_at: assignment ? epoch(assignment.assigned_at) : null,
      sale_name: user ? `${user.first_en} ${user.last_en}`.trim() : null,
      on,
      signal_status: tag.status === "disabled" ? "disabled" : !tag.last_ts ? "waiting" : on ? "online" : "offline",
      last_ts: epoch(tag.last_ts),
    };
  });
}

async function getLive(rows = 400, since = 0, projectId?: string): Promise<Profile> {
  const tags = await getTags(projectId);
  const tagMap = Object.fromEntries(tags.map((tag) => [tag.tag_id, {
    x: tag.x,
    y: tag.y,
    battery: tag.battery,
    on: tag.on,
    status: tag.signal_status,
    tag_type: tag.tag_type,
    project_id: tag.project_id,
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
    if (projectId) query = query.eq("project_id", projectId);
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
    let liveProjectId: string | null = null;
    let livePlanId: string | null = null;
    for (const project of projects) {
      const activePlan = (project.plans || []).find((plan: Profile) => plan.live);
      if (activePlan) {
        liveProjectId = project.project_id;
        livePlanId = activePlan.plan_id;
        break;
      }
    }
    if (!liveProjectId && projects.length) {
      liveProjectId = projects[0].project_id;
      livePlanId = projects[0].plan_id || projects[0].plans?.[0]?.plan_id || null;
    }
    const [zones, anchors] = livePlanId ? await Promise.all([
      db.from("zones").select("name,x_min,x_max,y_min,y_max").eq("plan_id", livePlanId).order("id")
        .then((result: any) => unwrap<any[]>(result)),
      getAnchors(undefined, livePlanId),
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
      live_plan_id: livePlanId,
      deal_statuses: DEAL_STATUSES,
    });
  }

  if (path === "/api/tags" && method === "GET") {
    const projectId = cleanNullableText(url.searchParams.get("project_id"), 100) ?? undefined;
    return json(req, { ok: true, tags: await getTags(projectId) });
  }
  if (path === "/api/tags" && method === "POST") {
    requireRole(profile, ["admin"]);
    const payload = await body(req);
    const tagId = cleanIdentifier(payload.tag_id, "Tag ID");
    const tagType = String(payload.tag_type ?? "physical").trim().toLowerCase();
    const status = String(payload.status ?? "active").trim().toLowerCase();
    const hardwareUid = cleanNullableText(payload.hardware_uid, 200);
    const label = cleanNullableText(payload.label, 200) ?? tagId;
    const projectId = payload.project_id == null || payload.project_id === ""
      ? null
      : cleanIdentifier(payload.project_id, "Project ID");
    const employeeId = payload.employee_id == null || payload.employee_id === ""
      ? null
      : cleanIdentifier(payload.employee_id, "Employee ID");
    if (!TAG_TYPES.has(tagType)) return fail(req, 422, "tag_type must be physical or mock");
    if (!TAG_STATUSES.has(status)) return fail(req, 422, "status must be active or disabled");
    if (hardwareUid && !HARDWARE_UID_PATTERN.test(hardwareUid)) return fail(req, 422, "Hardware UID is invalid");
    const duplicate = unwrap<any>(await db.from("tags").select("tag_id").eq("tag_id", tagId).maybeSingle());
    if (duplicate) return fail(req, 409, "Tag ID already exists");
    if (hardwareUid) {
      const duplicateUid = unwrap<any>(await db.from("tags").select("tag_id").eq("hardware_uid", hardwareUid).maybeSingle());
      if (duplicateUid) return fail(req, 409, "Hardware UID already exists");
    }
    if (projectId) await Promise.all([projectForAssignment(projectId, tagType), employeeExists(employeeId)]);
    else await employeeExists(employeeId);
    const now = new Date().toISOString();
    unwrap(await db.from("tags").insert({
      tag_id: tagId,
      hardware_uid: hardwareUid,
      label,
      tag_type: tagType,
      status,
      project_id: projectId,
      employee_id: employeeId,
      created_at: now,
      updated_at: now,
    }));
    if (projectId) await assignTag(tagId, projectId, employeeId, profile.id);
    const created = (await getTags(projectId ?? undefined)).find((tag) => tag.tag_id === tagId);
    return json(req, { ok: true, tag: created }, 201);
  }

  let tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch && method === "GET") {
    const tagId = decodeURIComponent(tagMatch[1]);
    const tag = (await getTags()).find((item) => item.tag_id === tagId);
    return tag ? json(req, { ok: true, tag }) : fail(req, 404, "Tag not found");
  }
  if (tagMatch && (method === "PATCH" || method === "PUT")) {
    requireRole(profile, ["admin"]);
    const tagId = decodeURIComponent(tagMatch[1]);
    const existing = unwrap<any>(await db.from("tags").select("*").eq("tag_id", tagId).maybeSingle());
    if (!existing) return fail(req, 404, "Tag not found");
    const payload = await body(req);
    const changes: Profile = {};
    if (payload.label !== undefined) changes.label = cleanNullableText(payload.label, 200) ?? tagId;
    if (payload.hardware_uid !== undefined) {
      const hardwareUid = cleanNullableText(payload.hardware_uid, 200);
      if (hardwareUid && !HARDWARE_UID_PATTERN.test(hardwareUid)) return fail(req, 422, "Hardware UID is invalid");
      if (hardwareUid) {
        const duplicateUid = unwrap<any>(await db.from("tags").select("tag_id").eq("hardware_uid", hardwareUid).neq("tag_id", tagId).maybeSingle());
        if (duplicateUid) return fail(req, 409, "Hardware UID already exists");
      }
      changes.hardware_uid = hardwareUid;
    }
    if (payload.tag_type !== undefined) {
      const tagType = String(payload.tag_type).trim().toLowerCase();
      if (!TAG_TYPES.has(tagType)) return fail(req, 422, "tag_type must be physical or mock");
      changes.tag_type = tagType;
      if (existing.project_id) await projectForAssignment(existing.project_id, tagType);
    }
    if (payload.status !== undefined) {
      const status = String(payload.status).trim().toLowerCase();
      if (!TAG_STATUSES.has(status)) return fail(req, 422, "status must be active or disabled");
      changes.status = status;
      if (status === "disabled") {
        const now = new Date().toISOString();
        await closeOpenVisits(tagId, now);
        changes.x = null;
        changes.y = null;
        changes.last_ts = null;
      }
    }
    if (!Object.keys(changes).length) return fail(req, 400, "No supported tag fields were provided");
    changes.updated_at = new Date().toISOString();
    unwrap(await db.from("tags").update(changes).eq("tag_id", tagId));
    const updated = (await getTags()).find((tag) => tag.tag_id === tagId);
    return json(req, { ok: true, tag: updated });
  }

  tagMatch = path.match(/^\/api\/tags\/([^/]+)\/assign$/);
  if (tagMatch && method === "POST") {
    requireRole(profile, ["admin"]);
    const tagId = decodeURIComponent(tagMatch[1]);
    const payload = await body(req);
    const projectId = cleanIdentifier(payload.project_id, "Project ID");
    const employeeId = payload.employee_id == null || payload.employee_id === ""
      ? null
      : cleanIdentifier(payload.employee_id, "Employee ID");
    const assignment = await assignTag(tagId, projectId, employeeId, profile.id);
    const tag = (await getTags(projectId)).find((item) => item.tag_id === tagId);
    return json(req, { ok: true, assignment, tag });
  }

  tagMatch = path.match(/^\/api\/tags\/([^/]+)\/deactivate$/);
  if (tagMatch && method === "POST") {
    requireRole(profile, ["admin"]);
    const tagId = decodeURIComponent(tagMatch[1]);
    const existing = unwrap<any>(await db.from("tags").select("tag_id").eq("tag_id", tagId).maybeSingle());
    if (!existing) return fail(req, 404, "Tag not found");
    const now = new Date().toISOString();
    await closeOpenVisits(tagId, now);
    unwrap(await db.from("tags").update({ status: "disabled", x: null, y: null, last_ts: null, updated_at: now }).eq("tag_id", tagId));
    const tag = (await getTags()).find((item) => item.tag_id === tagId);
    return json(req, { ok: true, tag });
  }

  if (path === "/api/devices" && method === "GET") {
    const projectId = cleanNullableText(url.searchParams.get("project_id"), 100) ?? undefined;
    const [anchors, tags] = await Promise.all([getAnchors(projectId), getTags(projectId)]);
    return json(req, { ok: true, anchors, tags });
  }
  if (path === "/api/live" && method === "GET") {
    const projectId = cleanNullableText(url.searchParams.get("project_id"), 100) ?? undefined;
    return json(req, await getLive(Number(url.searchParams.get("rows") ?? 400), Number(url.searchParams.get("since") ?? 0), projectId));
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
    const filters = visitFilters(url, profile);
    const projectId = filters.project || undefined;
    const [visits, anchors, tags] = await Promise.all([
      getVisits(filters), getAnchors(projectId), getTags(projectId),
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
    const trackingMode = String(payload.tracking_mode ?? "simulation").trim().toLowerCase();
    if (!TRACKING_MODES.has(trackingMode)) {
      return fail(req, 422, "tracking_mode must be hardware, simulation, or disabled");
    }
    unwrap(await db.from("projects").insert({
      id: payload.project_id, name: payload.name, province: payload.province || "",
      plan_id: payload.plan_id || "", plan_name: payload.plan_name || "",
      width_m: payload.width_m || 20, height_m: payload.height_m || 20,
      tracking_mode: trackingMode,
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

  match = path.match(/^\/api\/projects\/([^/]+)\/tracking-mode$/);
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const trackingMode = String(payload.tracking_mode ?? "").trim().toLowerCase();
    if (!TRACKING_MODES.has(trackingMode)) {
      return fail(req, 422, "tracking_mode must be hardware, simulation, or disabled");
    }
    const project = unwrap<any>(await db.from("projects").select("id").eq("id", projectId).maybeSingle());
    if (!project) return fail(req, 404, "ไม่พบโครงการ");
    // Leaving hardware mode would hand the project's real tags to the
    // simulator, so they have to be moved or disabled first.
    if (trackingMode !== "hardware") {
      const physical = unwrap<any[]>(await db
        .from("tags")
        .select("tag_id")
        .eq("project_id", projectId)
        .eq("tag_type", "physical")
        .eq("status", "active"));
      if (physical.length) {
        return fail(
          req,
          409,
          `ยังมีแท็กอุปกรณ์จริงในโครงการนี้ กรุณาย้ายหรือปิดใช้งานก่อน (${physical.map((tag) => tag.tag_id).join(", ")})`,
        );
      }
    }
    unwrap(await db.from("projects").update({ tracking_mode: trackingMode }).eq("id", projectId));
    return json(req, { ok: true, project: (await getProjects()).find((item) => item.project_id === projectId) });
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/gateways$/);
  if (match && method === "GET") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const gateways = unwrap<any[]>(await db
      .from("gateway_credentials")
      .select("gateway_id,project_id,status,last_seen_at,created_at,updated_at")
      .eq("project_id", projectId)
      .order("gateway_id"));
    return json(req, { ok: true, gateways });
  }
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const gatewayId = payload.gateway_id == null || payload.gateway_id === ""
      ? `GW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
      : cleanIdentifier(payload.gateway_id, "Gateway ID");
    const project = unwrap<any>(await db.from("projects").select("id,tracking_mode").eq("id", projectId).maybeSingle());
    if (!project) return fail(req, 404, "Project not found");
    const duplicate = unwrap<any>(await db.from("gateway_credentials").select("gateway_id").eq("gateway_id", gatewayId).maybeSingle());
    if (duplicate) return fail(req, 409, "Gateway ID already exists");
    const gatewayKey = randomGatewayKey();
    const now = new Date().toISOString();
    const inserted = unwrap<any>(await db.from("gateway_credentials").insert({
      gateway_id: gatewayId,
      project_id: projectId,
      key_hash: await sha256Hex(gatewayKey),
      status: "active",
      created_at: now,
      updated_at: now,
    }).select("gateway_id,project_id,status,last_seen_at,created_at,updated_at").single());
    if (project.tracking_mode !== "hardware") {
      unwrap(await db.from("projects").update({ tracking_mode: "hardware" }).eq("id", projectId));
    }
    return json(req, {
      ok: true,
      gateway: inserted,
      gateway_key: gatewayKey,
      warning: "Copy this key now. It will not be shown again.",
    }, 201);
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/gateways\/([^/]+)\/revoke$/);
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const gatewayId = decodeURIComponent(match[2]);
    const updated = unwrap<any>(await db.from("gateway_credentials")
      .update({ status: "revoked", updated_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .eq("gateway_id", gatewayId)
      .select("gateway_id,project_id,status,last_seen_at,created_at,updated_at")
      .maybeSingle());
    if (!updated) return fail(req, 404, "Gateway not found");
    return json(req, { ok: true, gateway: updated });
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/plans$/);
  if (match && method === "GET") return json(req, { ok: true, plans: await getPlans(decodeURIComponent(match[1])) });
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const project = unwrap<any>(await db.from("projects").select("id").eq("id", projectId).maybeSingle());
    if (!project) return fail(req, 404, "ไม่พบโครงการ");
    const planId = String(payload.plan_id || "").trim();
    const name = String(payload.name || "").trim();
    const width = Number(payload.width_m);
    const height = Number(payload.height_m);
    const version = payload.version == null ? 1 : Number(payload.version);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(planId)) return fail(req, 422, "Plan ID ไม่ถูกต้อง");
    if (!name) return fail(req, 422, "กรุณาระบุชื่อแปลน");
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return fail(req, 422, "ขนาดแปลนต้องมากกว่า 0 เมตร");
    if (!Number.isInteger(version) || version < 1) return fail(req, 422, "Version ต้องเป็นจำนวนเต็มตั้งแต่ 1");
    const duplicateId = unwrap<any>(await db.from("plans").select("id").eq("id", planId).maybeSingle());
    if (duplicateId) return fail(req, 409, "Plan ID นี้มีอยู่แล้ว");
    const duplicateName = unwrap<any>(await db.from("plans").select("id").eq("project_id", projectId).eq("name", name).maybeSingle());
    if (duplicateName) return fail(req, 409, "ชื่อแปลนซ้ำในโครงการ");
    const inserted = unwrap<any>(await db.from("plans").insert({
      id: planId, project_id: projectId, name,
      width_m: width, height_m: height,
      is_active: payload.is_active !== false, version,
    }).select().single());
    if (inserted.is_active) {
      unwrap(await db.from("plans").update({ is_active: false }).eq("project_id", projectId).neq("id", inserted.id));
    }
    await syncProjectPlan(projectId);
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
    const existing = unwrap<any>(await db.from("plans").select("id,project_id").eq("id", planId).maybeSingle());
    if (!existing) return fail(req, 404, "ไม่พบแปลน");
    const allowed: Profile = {};
    if (payload.name !== undefined) {
      const name = String(payload.name || "").trim();
      if (!name) return fail(req, 422, "กรุณาระบุชื่อแปลน");
      const duplicateName = unwrap<any>(await db.from("plans").select("id").eq("project_id", existing.project_id).eq("name", name).neq("id", planId).maybeSingle());
      if (duplicateName) return fail(req, 409, "ชื่อแปลนซ้ำในโครงการ");
      allowed.name = name;
    }
    for (const key of ["width_m", "height_m"]) {
      if (payload[key] === undefined) continue;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value <= 0) return fail(req, 422, "ขนาดแปลนต้องมากกว่า 0 เมตร");
      allowed[key] = value;
    }
    if (payload.version !== undefined) {
      const version = Number(payload.version);
      if (!Number.isInteger(version) || version < 1) return fail(req, 422, "Version ต้องเป็นจำนวนเต็มตั้งแต่ 1");
      allowed.version = version;
    }
    if (payload.is_active !== undefined) allowed.is_active = Boolean(payload.is_active);
    if (!Object.keys(allowed).length) return fail(req, 400, "ไม่มีข้อมูลสำหรับแก้ไขแปลน");
    const updated = unwrap<any>(await db.from("plans").update({ ...allowed, updated_at: new Date().toISOString() }).eq("id", planId).select().single());
    if (updated.is_active) {
      unwrap(await db.from("plans").update({ is_active: false }).eq("project_id", updated.project_id).neq("id", planId));
    }
    await syncProjectPlan(updated.project_id);
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

  match = path.match(/^\/api\/positioning\/([^/]+)(?:\/ingest)?$/);
  if (match && method === "GET") {
    const live = await getLive(0, 0, decodeURIComponent(match[1]));
    return json(req, { ok: true, project_id: decodeURIComponent(match[1]), tags: live.tags });
  }
  if (match && method === "POST") {
    requireRole(profile, ["admin"]);
    const projectId = decodeURIComponent(match[1]);
    const payload = await body(req);
    const project = unwrap<any>(await db
      .from("projects")
      .select("id,plan_id,tracking_mode")
      .eq("id", projectId)
      .maybeSingle());
    if (!project) return fail(req, 404, "Project not found");
    if (project.tracking_mode !== "simulation") {
      return fail(req, 403, "Authenticated positioning only accepts mock tags; hardware must use uwb-ingest");
    }
    const tagId = cleanIdentifier(payload.tag_id, "Tag ID");
    const tag = unwrap<any>(await db.from("tags").select("*").eq("tag_id", tagId).maybeSingle());
    if (!tag) return fail(req, 404, "Tag not found");
    if (tag.tag_type !== "mock" || tag.status !== "active") {
      return fail(req, 403, "This endpoint accepts active mock tags only");
    }
    const assignment = unwrap<any>(await db
      .from("tag_assignments")
      .select("employee_id")
      .eq("tag_id", tagId)
      .eq("project_id", projectId)
      .is("ended_at", null)
      .maybeSingle());
    if (!assignment) return fail(req, 409, "Tag is not actively assigned to this project");
    const anchors = await getAnchors(projectId, project.plan_id || undefined);
    const anchorMap = new Map(anchors.map((anchor) => [anchor.anchor_id, anchor]));
    const ranges = Array.isArray(payload.ranges) ? payload.ranges : [];
    const seenAnchors = new Set<string>();
    const known = ranges.map((range: Profile) => {
      const anchorId = String(range.anchor_id ?? "").trim();
      const distance = Number(range.distance_m);
      if (!anchorId || seenAnchors.has(anchorId) || !Number.isFinite(distance) || distance <= 0) return null;
      seenAnchors.add(anchorId);
      return { anchor: anchorMap.get(anchorId), distance };
    }).filter((item: any) => item?.anchor);
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
    const zones = unwrap<any[]>(await db.from("zones").select("name,x_min,x_max,y_min,y_max").eq("project_id", projectId).eq("plan_id", project.plan_id));
    const zone = zones.find((item) => item.x_min <= x && x <= item.x_max && item.y_min <= y && y <= item.y_max)?.name ?? null;
    const suppliedTs = Date.parse(String(payload.measured_at ?? payload.device_ts ?? ""));
    const measuredAt = Number.isFinite(suppliedTs) ? new Date(suppliedTs).toISOString() : new Date().toISOString();
    const messageId = cleanNullableText(payload.message_id, 128) ?? `sim-${crypto.randomUUID()}`;
    const battery = payload.battery_pct == null && payload.battery == null ? tag.battery : Number(payload.battery_pct ?? payload.battery);
    if (battery != null && (!Number.isFinite(battery) || battery < 0 || battery > 100)) {
      return fail(req, 422, "Battery must be between 0 and 100");
    }
    if (!tag) return fail(req, 404, "ไม่พบ tag");
    unwrap(await db.from("positions").insert({
      tag_id: tagId,
      project_id: projectId,
      plan_id: project.plan_id,
      source: "simulator",
      message_id: messageId,
      device_ts: measuredAt,
      x,
      y,
      zone,
      ts: measuredAt,
      residual_m: residual,
      anchors_used: known.length,
    }));
    unwrap(await db.from("tags").update({ x, y, battery, last_ts: measuredAt, updated_at: new Date().toISOString() }).eq("tag_id", tagId));
    const openVisit = unwrap<any>(await db.from("visits").select("visit_key").eq("tag_id", tagId).is("ended_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle());
    if (!openVisit) {
      const visitKey = `V-${Math.floor(Date.now() / 1000)}-${tagId}-${crypto.randomUUID().slice(0, 6)}`;
      unwrap(await db.from("visits").insert({ visit_key: visitKey, tag_id: tagId, employee_id: assignment.employee_id, project_id: projectId, plan_id: project.plan_id, started_at: measuredAt, source: "simulator", deal_status: "" }));
    }
    return json(req, { ok: true, tag_id: tagId, project_id: projectId, plan_id: project.plan_id, source: "simulator", message_id: messageId, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, zone, residual_m: Math.round(residual * 10000) / 10000, anchors_used: known.length, ts: Date.parse(measuredAt) / 1000 });
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
    if (error instanceof HttpError) return fail(req, error.status, error.message);
    if ((error as any)?.code === "23505") return fail(req, 409, "A record with the same unique identifier already exists");
    if ((error as any)?.code === "23503") return fail(req, 409, "A referenced project, employee, or tag does not exist");
    console.error(error);
    return fail(req, 500, error instanceof Error ? error.message : "Internal server error");
  }
});
