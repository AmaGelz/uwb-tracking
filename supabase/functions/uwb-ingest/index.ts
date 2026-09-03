// Hardware ingest endpoint for real UWB gateways.
//
// Deliberately separate from the `api` function: `api` verifies a Supabase
// Auth JWT belonging to a dashboard user, while a gateway is an unattended
// device that authenticates with a project-scoped key issued by an admin
// (POST /api/projects/{id}/gateways). Only the SHA-256 digest of that key is
// stored, so a leaked database dump cannot be replayed against this endpoint.
//
// Every accepted message is written through the ingest_uwb_fix RPC, which
// repeats the tag / project / assignment checks inside the database and writes
// the position, the tag snapshot and the visit lifecycle in one transaction.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A fix from the future is a broken clock; a very old one is a replay or a
// queue that has been offline for hours. Neither describes a live position, so
// both are refused rather than reopening a stale visit.
const MAX_CLOCK_SKEW_SEC = 300;
const MAX_MESSAGE_AGE_SEC = 900;
const MAX_RANGES = 32;

type Row = Record<string, any>;

class IngestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function unwrap<T>(result: { data: T; error: any }): T {
  if (result.error) {
    const error: any = new Error(result.error.message);
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}

function identifier(value: unknown, field: string, pattern = ID_PATTERN): string {
  const result = String(value ?? "").trim();
  if (!pattern.test(result)) throw new IngestError(422, `${field} is invalid`);
  return result;
}

function finiteNumber(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new IngestError(422, `${field} must be a finite number`);
  return result;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// These are digests rather than secrets, but comparing them in constant time
// keeps response timing from narrowing down a key one byte at a time.
function digestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function gatewayKeyFrom(req: Request): string {
  const header = req.headers.get("x-gateway-key");
  if (header) return header.trim();
  const authorization = req.headers.get("authorization") ?? "";
  return authorization.replace(/^Gateway\s+/i, "").trim();
}

async function authenticateGateway(req: Request, payload: Row): Promise<Row> {
  const suppliedId = req.headers.get("x-gateway-id") ?? payload.gateway_id;
  const gatewayKey = gatewayKeyFrom(req);
  if (!suppliedId || !gatewayKey) {
    throw new IngestError(401, "X-Gateway-Id and X-Gateway-Key are required");
  }
  const gatewayId = identifier(suppliedId, "Gateway ID");

  const credential = unwrap<Row>(await db
    .from("gateway_credentials")
    .select("gateway_id,project_id,key_hash,status")
    .eq("gateway_id", gatewayId)
    .maybeSingle());
  // An unknown gateway, a revoked one, and a wrong key all answer alike.
  if (!credential || credential.status !== "active") {
    throw new IngestError(401, "Gateway is not authorised");
  }
  if (!digestsMatch(await sha256Hex(gatewayKey), String(credential.key_hash))) {
    throw new IngestError(401, "Gateway is not authorised");
  }
  return credential;
}

function measuredAt(payload: Row): Date {
  const supplied = payload.device_ts ?? payload.measured_at;
  if (supplied === undefined || supplied === null || supplied === "") return new Date();

  // Epoch seconds are what the firmware examples send; ISO strings and epoch
  // milliseconds are both accepted so a gateway does not have to convert.
  const parsed = typeof supplied === "number"
    ? new Date(supplied * (supplied > 1e12 ? 1 : 1000))
    : new Date(String(supplied));
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) throw new IngestError(422, "device_ts is not a valid timestamp");

  const skewSec = (ms - Date.now()) / 1000;
  if (skewSec > MAX_CLOCK_SKEW_SEC) throw new IngestError(422, "device_ts is in the future");
  if (-skewSec > MAX_MESSAGE_AGE_SEC) throw new IngestError(422, "device_ts is too old to accept");
  return parsed;
}

/** Least-squares multilateration, linearised against the last anchor. */
function solvePosition(
  known: { x: number; y: number; distance: number }[],
): { x: number; y: number; residualM: number } {
  const reference = known[known.length - 1];
  let aa = 0, ab = 0, bb = 0, ac = 0, bc = 0;
  for (const item of known.slice(0, -1)) {
    const a = 2 * (item.x - reference.x);
    const b = 2 * (item.y - reference.y);
    const c = reference.distance ** 2 - item.distance ** 2
      + item.x ** 2 - reference.x ** 2
      + item.y ** 2 - reference.y ** 2;
    aa += a * a;
    ab += a * b;
    bb += b * b;
    ac += a * c;
    bc += b * c;
  }
  const determinant = aa * bb - ab * ab;
  if (Math.abs(determinant) < 1e-9) throw new IngestError(422, "Anchor geometry is degenerate");

  const x = (ac * bb - bc * ab) / determinant;
  const y = (bc * aa - ac * ab) / determinant;
  const residualM = Math.sqrt(
    known.reduce(
      (sum, item) => sum + (Math.hypot(item.x - x, item.y - y) - item.distance) ** 2,
      0,
    ) / known.length,
  );
  return { x, y, residualM };
}

/** Rows for the active plan when the survey has been migrated, else the whole project. */
function forActivePlan(rows: Row[], planId: string | null): Row[] {
  if (!planId) return rows;
  const scoped = rows.filter((row) => row.plan_id === planId);
  return scoped.length ? scoped : rows;
}

async function resolveTagId(payload: Row): Promise<string> {
  if (payload.tag_id !== undefined && payload.tag_id !== null && payload.tag_id !== "") {
    return identifier(payload.tag_id, "Tag ID");
  }
  // Firmware that only knows its own serial number can report hardware_uid
  // instead; the RPC still re-checks type, status and assignment.
  const hardwareUid = identifier(payload.hardware_uid, "Hardware UID");
  const tag = unwrap<Row>(await db
    .from("tags")
    .select("tag_id")
    .eq("hardware_uid", hardwareUid)
    .maybeSingle());
  if (!tag) throw new IngestError(404, "Hardware UID is not registered");
  return tag.tag_id;
}

async function positionFrom(payload: Row, projectId: string, planId: string | null): Promise<{
  x: number;
  y: number;
  residualM: number | null;
  anchorsUsed: number | null;
  anchorIds: string[];
}> {
  const ranges = Array.isArray(payload.ranges) ? payload.ranges.slice(0, MAX_RANGES) : [];
  if (!ranges.length) {
    // A gateway that solves positions on-device may post the fix directly.
    const solved = {
      x: finiteNumber(payload.x, "x"),
      y: finiteNumber(payload.y, "y"),
      residualM: payload.residual_m === undefined || payload.residual_m === null
        ? null
        : Math.abs(finiteNumber(payload.residual_m, "residual_m")),
      anchorsUsed: payload.anchors_used === undefined || payload.anchors_used === null
        ? null
        : Math.max(0, Math.trunc(finiteNumber(payload.anchors_used, "anchors_used"))),
      anchorIds: [] as string[],
    };
    return solved;
  }

  const anchors = forActivePlan(
    unwrap<Row[]>(await db.from("anchors").select("anchor_id,plan_id,x,y").eq("project_id", projectId)),
    planId,
  );
  const anchorById = new Map(anchors.map((anchor) => [anchor.anchor_id, anchor]));

  const seen = new Set<string>();
  const known: { x: number; y: number; distance: number }[] = [];
  for (const range of ranges) {
    const anchorId = String(range?.anchor_id ?? "").trim();
    const distance = Number(range?.distance_m);
    const anchor = anchorById.get(anchorId);
    if (!anchor || seen.has(anchorId)) continue;
    if (!Number.isFinite(distance) || distance <= 0) continue;
    seen.add(anchorId);
    known.push({ x: Number(anchor.x), y: Number(anchor.y), distance });
  }
  if (known.length < 3) {
    throw new IngestError(
      400,
      `At least 3 ranges from anchors registered in ${projectId} are required (usable: ${known.length})`,
    );
  }

  const fix = solvePosition(known);
  return {
    x: fix.x,
    y: fix.y,
    residualM: fix.residualM,
    anchorsUsed: known.length,
    anchorIds: [...seen],
  };
}

function batteryFrom(payload: Row): number | null {
  const reported = payload.battery_pct ?? payload.battery;
  if (reported === undefined || reported === null) return null;
  const battery = finiteNumber(reported, "battery");
  if (battery < 0 || battery > 100) throw new IngestError(422, "battery must be between 0 and 100");
  return battery;
}

async function ingest(req: Request): Promise<Response> {
  const payload: Row = await req.json().catch(() => {
    throw new IngestError(400, "Request body must be JSON");
  });
  const credential = await authenticateGateway(req, payload);
  const projectId = String(credential.project_id);
  if (payload.project_id && identifier(payload.project_id, "Project ID") !== projectId) {
    throw new IngestError(403, "Gateway is not authorised for that project");
  }

  const project = unwrap<Row>(await db
    .from("projects")
    .select("id,plan_id,tracking_mode")
    .eq("id", projectId)
    .maybeSingle());
  if (!project) throw new IngestError(404, "Project not found");
  if (project.tracking_mode !== "hardware") {
    throw new IngestError(409, `Project ${projectId} is not in hardware tracking mode`);
  }
  const planId = project.plan_id || null;

  const tagId = await resolveTagId(payload);
  const messageId = identifier(payload.message_id, "Message ID", MESSAGE_ID_PATTERN);
  const deviceTs = measuredAt(payload);
  const fix = await positionFrom(payload, projectId, planId);
  const battery = batteryFrom(payload);

  const zones = forActivePlan(
    unwrap<Row[]>(await db
      .from("zones")
      .select("name,plan_id,x_min,x_max,y_min,y_max")
      .eq("project_id", projectId)),
    planId,
  );
  const zone = zones.find((item) =>
    item.x_min <= fix.x && fix.x <= item.x_max && item.y_min <= fix.y && fix.y <= item.y_max
  )?.name ?? null;

  const result = unwrap<Row>(await db.rpc("ingest_uwb_fix", {
    p_gateway_id: credential.gateway_id,
    p_message_id: messageId,
    p_tag_id: tagId,
    p_project_id: projectId,
    p_plan_id: planId,
    p_device_ts: deviceTs.toISOString(),
    p_x: fix.x,
    p_y: fix.y,
    p_zone: zone,
    p_battery: battery,
    p_residual_m: fix.residualM,
    p_anchors_used: fix.anchorsUsed,
  }));
  const duplicate = Boolean(result?.duplicate);

  // The anchors that produced this fix are demonstrably alive, so anchor
  // status on the dashboard follows the gateway instead of the simulator.
  if (fix.anchorIds.length && !duplicate) {
    unwrap(await db
      .from("anchors")
      .update({ last_ts: deviceTs.toISOString() })
      .eq("project_id", projectId)
      .in("anchor_id", fix.anchorIds));
  }

  return json({
    ok: true,
    duplicate,
    tag_id: tagId,
    project_id: projectId,
    plan_id: planId,
    gateway_id: credential.gateway_id,
    message_id: messageId,
    source: "hardware",
    x: Math.round(fix.x * 1000) / 1000,
    y: Math.round(fix.y * 1000) / 1000,
    zone,
    residual_m: fix.residualM === null ? null : Math.round(fix.residualM * 10000) / 10000,
    anchors_used: fix.anchorsUsed,
    visit_key: result?.visit_key ?? null,
    ts: deviceTs.getTime() / 1000,
  }, duplicate ? 200 : 201);
}

Deno.serve(async (req: Request) => {
  // Gateways are not browsers: there is no CORS allow-list and no cookie to
  // protect, only the key in the request headers.
  if (req.method !== "POST") return json({ detail: "Only POST is supported" }, 405);

  try {
    return await ingest(req);
  } catch (error) {
    if (error instanceof IngestError) return json({ detail: error.message }, error.status);
    const message = error instanceof Error ? error.message : "Internal server error";
    // A policy violation raised inside ingest_uwb_fix is the gateway sending
    // something the database refuses, not a server fault: report it verbatim.
    if ((error as any)?.code === "P0001") return json({ detail: message }, 409);
    if ((error as any)?.code === "23505") return json({ detail: "Duplicate message" }, 409);
    console.error(error);
    return json({ detail: message }, 500);
  }
});
