"""Generator for database/seed.sql.

Regenerate anytime with:

    python scripts/generate_seed.py

Produces a deterministic (fixed random seed), readable seed.sql with
enough historical visit data for the analytics/funnel/zone-comparison
views to show something real instead of empty states. Not imported by
the running app — this is a maintenance/dev tool, not app code.
"""
import hashlib
import random
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path


def password_hash(password: str, salt: str) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256$120000${salt}${digest.hex()}"


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


random.seed(42)

NOW = datetime(2026, 8, 19, 9, 0, 0, tzinfo=timezone.utc)

lines = []
lines.append("-- =========================================================")
lines.append("-- SUPALAI-UWB — demo/seed data (PostgreSQL / Supabase)")
lines.append("-- =========================================================")
lines.append("-- Generated deterministically; safe to re-run (ON CONFLICT DO NOTHING).")
lines.append("-- Demo accounts (password for all: 1234):")
lines.append("--   admin@supalai.com      (role: admin)")
lines.append("--   lead@supalai.com       (role: sale_lead)")
lines.append("--   mandee.jai@supalai.com (role: sale, tag TAG01)")
lines.append("--   somchai.d@supalai.com  (role: sale, tag TAG02)")
lines.append("-- =========================================================")
lines.append("")

# ---------------------------------------------------------------- users
FIXED_SALT = "d2b6b6f2c1e94a2c9b6e4f7a10b2c344"  # fixed so re-generation is deterministic
users = [
    ("u-admin", "ADMIN001", "admin@supalai.com", "admin", "Administrator",
     "ผู้ดูแล", "ระบบ", "Admin", "SUPALAI", "020000001", None),
    ("u-lead", "LEAD001", "lead@supalai.com", "sale_lead", "Sales Team Lead",
     "หัวหน้าทีม", "ขายดี", "Lead", "Khaidee", "020000002", None),
    ("u-sale", "SALE001", "mandee.jai@supalai.com", "sale", "Sales Representative",
     "มณดี", "ใจดี", "Mandee", "Jai Dee", "0812345001", "TAG01"),
    ("u-sale2", "SALE002", "somchai.d@supalai.com", "sale", "Sales Representative",
     "สมชาย", "ดีเลิศ", "Somchai", "Deelert", "0812345002", "TAG02"),
]

lines.append("-- ---------------------------------------------------- users")
for uid, emp, email, role, pos, fth, lth, fen, len_, phone, tag in users:
    ph = password_hash("1234", FIXED_SALT)
    lines.append(
        "INSERT INTO users (id, employee_id, email, password_hash, role, position, "
        "first_th, last_th, first_en, last_en, phone, tag_id) VALUES "
        f"({sql_str(uid)}, {sql_str(emp)}, {sql_str(email)}, {sql_str(ph)}, {sql_str(role)}, "
        f"{sql_str(pos)}, {sql_str(fth)}, {sql_str(lth)}, {sql_str(fen)}, {sql_str(len_)}, "
        f"{sql_str(phone)}, {sql_str(tag)}) ON CONFLICT (id) DO NOTHING;"
    )
lines.append("")

# ------------------------------------------------------------- projects
lines.append("-- ---------------------------------------------------- projects")
lines.append(
    "INSERT INTO projects (id, name, province, plan_id, plan_name, width_m, height_m) VALUES "
    "('P001', 'SUPALAI Demo Project', 'กรุงเทพมหานคร', 'PLAN01', 'Main Floor', 20, 15) "
    "ON CONFLICT (id) DO NOTHING;"
)
lines.append(
    "INSERT INTO projects (id, name, province, plan_id, plan_name, width_m, height_m) VALUES "
    "('P002', 'ศุภาลัย วิลล์ ราชพฤกษ์', 'นนทบุรี', 'PLAN-B', 'แบบบ้าน B - 2 ชั้น', 6.5, 6.5) "
    "ON CONFLICT (id) DO NOTHING;"
)
lines.append("")

# ---------------------------------------------------------------- zones
lines.append("-- ---------------------------------------------------- zones")
p001_zones = [
    ("Entrance", 0.0, 4.0, 0.0, 15.0),
    ("Living Room", 4.0, 12.0, 0.0, 8.0),
    ("Kitchen", 12.0, 20.0, 0.0, 8.0),
    ("Bedroom 1", 4.0, 12.0, 8.0, 15.0),
    ("Bedroom 2", 12.0, 20.0, 8.0, 15.0),
]
for name, x0, x1, y0, y1 in p001_zones:
    lines.append(
        f"INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES "
        f"('P001', {sql_str(name)}, {x0}, {x1}, {y0}, {y1}) "
        f"ON CONFLICT (project_id, name) DO NOTHING;"
    )
p002_zones = [
    ("Living room", 0.0, 4.0, 0.0, 3.5),
    ("Kitchen", 4.0, 6.5, 0.0, 3.5),
    ("Bed room 1", 0.0, 3.2, 3.5, 6.5),
    ("Bed room 2", 3.2, 6.5, 3.5, 6.5),
]
for name, x0, x1, y0, y1 in p002_zones:
    lines.append(
        f"INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES "
        f"('P002', {sql_str(name)}, {x0}, {x1}, {y0}, {y1}) "
        f"ON CONFLICT (project_id, name) DO NOTHING;"
    )
lines.append("")

# -------------------------------------------------------------- anchors
lines.append("-- ---------------------------------------------------- anchors")
anchors = [("A01", 1.0, 1.0, 95), ("A02", 19.0, 1.0, 91), ("A03", 1.0, 14.0, 88), ("A04", 19.0, 14.0, 93)]
for aid, x, y, batt in anchors:
    lines.append(
        f"INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES "
        f"('P001', {sql_str(aid)}, {x}, {y}, {batt}, now()) "
        f"ON CONFLICT (project_id, anchor_id) DO NOTHING;"
    )
lines.append("")

# ----------------------------------------------------------------- tags
lines.append("-- ---------------------------------------------------- tags")
lines.append(
    "INSERT INTO tags (tag_id, employee_id, project_id, x, y, battery, last_ts) VALUES "
    "('TAG01', 'SALE001', 'P001', 8.2, 6.4, 82, now()) ON CONFLICT (tag_id) DO NOTHING;"
)
lines.append(
    "INSERT INTO tags (tag_id, employee_id, project_id, x, y, battery, last_ts) VALUES "
    "('TAG02', 'SALE002', 'P001', 14.5, 10.2, 77, now()) ON CONFLICT (tag_id) DO NOTHING;"
)
lines.append("")

# ------------------------------------------------------------ customers
lines.append("-- ---------------------------------------------------- customers")
customers = [
    ("C001", "Demo Customer"),
    ("C002", "Walk-in Customer"),
    ("C003", "คุณสมศรี รักบ้าน"),
    ("C004", "คุณประยุทธ มั่งมี"),
    ("C005", "คุณกาญจนา ศรีสุข"),
    ("C006", "คุณวิชัย ทองดี"),
    ("C007", "คุณนภา แสงจันทร์"),
    ("C008", "คุณธีรพงษ์ เจริญสุข"),
]
for cid, name in customers:
    lines.append(f"INSERT INTO customers (id, name) VALUES ({sql_str(cid)}, {sql_str(name)}) ON CONFLICT (id) DO NOTHING;")
lines.append("")

# -------------------------------------------------------------- visits
lines.append("-- ---------------------------------------------------- visits (21 days of demo history)")
lines.append("-- Historical visits at P001 for both sales reps: varied hour/weekday/zone/outcome so")
lines.append("-- the funnel, duration-by-outcome, zone comparison and by-person analytics have data.")

employees = [("SALE001", "TAG01"), ("SALE002", "TAG02")]
zone_names = [z[0] for z in p001_zones]
deal_pool = (["ปิดการขาย"] * 9 + ["ยกเลิกการขาย"] * 6 + [""] * 10)  # ~36% won / 24% lost / 40% unlabelled among decided pool mix

visit_rows = []
note_rows = []
visit_seq = 0
for day_offset in range(21, 0, -1):
    day = NOW - timedelta(days=day_offset)
    n_visits_today = random.choice([0, 1, 1, 2, 2, 3])
    for _ in range(n_visits_today):
        emp, tag = random.choice(employees)
        hour = random.choice([9, 10, 11, 13, 14, 15, 16, 17])
        minute = random.randint(0, 59)
        started = day.replace(hour=hour, minute=minute, second=random.randint(0, 59), microsecond=0)
        duration = random.randint(180, 3300)
        ended = started + timedelta(seconds=duration)
        zone = random.choice(zone_names)
        customer = random.choice(customers)[0] if random.random() < 0.75 else None
        deal = random.choice(deal_pool) if customer else ""
        # Zone bias: visits that end in "ปิดการขาย" skew toward Living Room / Kitchen
        # (mirrors the idea that time in the show-off rooms correlates with closing).
        if deal == "ปิดการขาย" and random.random() < 0.5:
            zone = random.choice(["Living Room", "Kitchen"])
            duration = int(duration * random.uniform(1.15, 1.5))
            ended = started + timedelta(seconds=duration)

        visit_seq += 1
        visit_key = f"V-DEMO-{visit_seq:04d}"
        visit_rows.append((visit_key, tag, emp, "P001", "PLAN01", customer, started, ended, duration, zone, deal))

        if random.random() < 0.18 and customer:
            note_rows.append((visit_key, emp, random.choice([
                "ลูกค้าสนใจแบบบ้านมาก ถามเรื่องการผ่อนดาวน์",
                "นัดกลับมาดูอีกรอบพร้อมครอบครัว",
                "ลูกค้าเทียบราคากับโครงการใกล้เคียง",
                "สนใจโปรโมชั่นเฟอร์นิเจอร์แถม",
                "ขอเอกสารสินเชื่อไปศึกษาเพิ่มเติม",
            ])))

for vk, tag, emp, proj, plan, cust, started, ended, dur, zone, deal in visit_rows:
    lines.append(
        "INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, "
        "started_at, ended_at, duration_sec, zone, deal_status) VALUES ("
        f"{sql_str(vk)}, {sql_str(tag)}, {sql_str(emp)}, {sql_str(proj)}, {sql_str(plan)}, "
        f"{sql_str(cust)}, {sql_str(started.isoformat())}, {sql_str(ended.isoformat())}, {dur}, "
        f"{sql_str(zone)}, {sql_str(deal)}) ON CONFLICT (visit_key) DO NOTHING;"
    )
lines.append("")

lines.append("-- ---------------------------------------------------- notes")
for i, (vk, emp, body) in enumerate(note_rows, start=1):
    user_id = "u-sale" if emp == "SALE001" else "u-sale2"
    seed_key = f"SEED-NOTE-{i:04d}"
    lines.append(
        f"INSERT INTO notes (visit_key, user_id, body, created_at, seed_key) VALUES "
        f"({sql_str(vk)}, {sql_str(user_id)}, {sql_str(body)}, now(), {sql_str(seed_key)}) "
        f"ON CONFLICT (seed_key) DO NOTHING;"
    )
lines.append("")

with open(Path(__file__).resolve().parent.parent / "database" / "seed.sql", "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")

print(f"visits generated: {len(visit_rows)}, notes: {len(note_rows)}")
