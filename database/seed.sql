-- =========================================================
-- SUPALAI-UWB — demo/seed data (PostgreSQL / Supabase)
-- =========================================================
-- Generated deterministically; safe to re-run (ON CONFLICT DO NOTHING).
-- Demo accounts (password for all: 1234):
--   admin@supalai.com      (role: admin)
--   lead@supalai.com       (role: sale_lead)
--   mandee.jai@supalai.com (role: sale, tag TAG01)
--   somchai.d@supalai.com  (role: sale, tag TAG02)
-- =========================================================

-- ---------------------------------------------------- users
INSERT INTO users (id, employee_id, email, password_hash, role, position, first_th, last_th, first_en, last_en, phone, tag_id) VALUES ('u-admin', 'ADMIN001', 'admin@supalai.com', 'pbkdf2_sha256$120000$d2b6b6f2c1e94a2c9b6e4f7a10b2c344$f0c24f4ada126701585ba7ce471d5f454778aaf345e1f6c10922bc34b31fb958', 'admin', 'Administrator', 'ผู้ดูแล', 'ระบบ', 'Admin', 'SUPALAI', '020000001', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, employee_id, email, password_hash, role, position, first_th, last_th, first_en, last_en, phone, tag_id) VALUES ('u-lead', 'LEAD001', 'lead@supalai.com', 'pbkdf2_sha256$120000$d2b6b6f2c1e94a2c9b6e4f7a10b2c344$f0c24f4ada126701585ba7ce471d5f454778aaf345e1f6c10922bc34b31fb958', 'sale_lead', 'Sales Team Lead', 'หัวหน้าทีม', 'ขายดี', 'Lead', 'Khaidee', '020000002', NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, employee_id, email, password_hash, role, position, first_th, last_th, first_en, last_en, phone, tag_id) VALUES ('u-sale', 'SALE001', 'mandee.jai@supalai.com', 'pbkdf2_sha256$120000$d2b6b6f2c1e94a2c9b6e4f7a10b2c344$f0c24f4ada126701585ba7ce471d5f454778aaf345e1f6c10922bc34b31fb958', 'sale', 'Sales Representative', 'มณดี', 'ใจดี', 'Mandee', 'Jai Dee', '0812345001', 'TAG01') ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, employee_id, email, password_hash, role, position, first_th, last_th, first_en, last_en, phone, tag_id) VALUES ('u-sale2', 'SALE002', 'somchai.d@supalai.com', 'pbkdf2_sha256$120000$d2b6b6f2c1e94a2c9b6e4f7a10b2c344$f0c24f4ada126701585ba7ce471d5f454778aaf345e1f6c10922bc34b31fb958', 'sale', 'Sales Representative', 'สมชาย', 'ดีเลิศ', 'Somchai', 'Deelert', '0812345002', 'TAG02') ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------- projects
-- Both seeded projects intentionally keep the schema default
-- tracking_mode='simulation'. Registering a physical tag through the admin API
-- switches only the selected project to hardware mode.
INSERT INTO projects (id, name, province, plan_id, plan_name, width_m, height_m, tracking_mode) VALUES ('P001', 'SUPALAI Demo Project', 'กรุงเทพมหานคร', 'PLAN01', 'Main Floor', 20, 15, 'simulation') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, province, plan_id, plan_name, width_m, height_m, tracking_mode) VALUES ('P002', 'ศุภาลัย วิลล์ ราชพฤกษ์', 'นนทบุรี', 'PLAN-B', 'แบบบ้าน B - 2 ชั้น', 6.5, 6.5, 'simulation') ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------- zones
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P001', 'Entrance', 0.0, 4.0, 0.0, 15.0) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P001', 'Living Room', 4.0, 12.0, 0.0, 8.0) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P001', 'Kitchen', 12.0, 20.0, 0.0, 8.0) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P001', 'Bedroom 1', 4.0, 12.0, 8.0, 15.0) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P001', 'Bedroom 2', 12.0, 20.0, 8.0, 15.0) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P002', 'Living room', 0.0, 4.0, 0.0, 3.5) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P002', 'Kitchen', 4.0, 6.5, 0.0, 3.5) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P002', 'Bed room 1', 0.0, 3.2, 3.5, 6.5) ON CONFLICT (project_id, name) DO NOTHING;
INSERT INTO zones (project_id, name, x_min, x_max, y_min, y_max) VALUES ('P002', 'Bed room 2', 3.2, 6.5, 3.5, 6.5) ON CONFLICT (project_id, name) DO NOTHING;

-- ---------------------------------------------------- anchors
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P001', 'A01', 1.0, 1.0, 95, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P001', 'A02', 19.0, 1.0, 91, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P001', 'A03', 1.0, 14.0, 88, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P001', 'A04', 19.0, 14.0, 93, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P002', 'A01', 0.5, 0.5, 96, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P002', 'A02', 6.0, 0.5, 94, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P002', 'A03', 0.5, 6.0, 92, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;
INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts) VALUES ('P002', 'A04', 6.0, 6.0, 90, now()) ON CONFLICT (project_id, anchor_id) DO NOTHING;

-- ---------------------------------------------------- tags
-- All shipped demo tags are explicitly mock. A real hardware identifier must
-- be registered through the admin workflow rather than being seeded.
INSERT INTO tags (tag_id, label, tag_type, status, employee_id, project_id, x, y, battery, last_ts) VALUES ('TAG01', 'Demo tag 01', 'mock', 'active', 'SALE001', 'P001', 8.2, 6.4, 82, now()) ON CONFLICT (tag_id) DO NOTHING;
INSERT INTO tags (tag_id, label, tag_type, status, employee_id, project_id, x, y, battery, last_ts) VALUES ('TAG02', 'Demo tag 02', 'mock', 'active', 'SALE002', 'P001', 14.5, 10.2, 77, now()) ON CONFLICT (tag_id) DO NOTHING;
INSERT INTO tags (tag_id, label, tag_type, status, employee_id, project_id, x, y, battery, last_ts) VALUES ('MOCK-P002-01', 'P002 demo tag', 'mock', 'active', NULL, 'P002', 3.0, 3.0, 85, now()) ON CONFLICT (tag_id) DO NOTHING;

-- Initialize assignment history without reactivating a tag that an admin has
-- already moved or deactivated. The legacy project_id/employee_id columns are
-- retained as the current snapshot for backwards-compatible clients.
INSERT INTO tag_assignments (tag_id, project_id, employee_id)
SELECT tag.tag_id, tag.project_id, tag.employee_id
FROM tags tag
WHERE tag.tag_id IN ('TAG01', 'TAG02', 'MOCK-P002-01')
  AND tag.project_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM tag_assignments assignment
      WHERE assignment.tag_id = tag.tag_id
  );

-- ---------------------------------------------------- customers
INSERT INTO customers (id, name) VALUES ('C001', 'Demo Customer') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C002', 'Walk-in Customer') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C003', 'คุณสมศรี รักบ้าน') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C004', 'คุณประยุทธ มั่งมี') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C005', 'คุณกาญจนา ศรีสุข') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C006', 'คุณวิชัย ทองดี') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C007', 'คุณนภา แสงจันทร์') ON CONFLICT (id) DO NOTHING;
INSERT INTO customers (id, name) VALUES ('C008', 'คุณธีรพงษ์ เจริญสุข') ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------- visits (21 days of demo history)
-- Historical visits at P001 for both sales reps: varied hour/weekday/zone/outcome so
-- the funnel, duration-by-outcome, zone comparison and by-person analytics have data.
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0001', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C002', '2026-07-29T09:47:17+00:00', '2026-07-29T10:07:00+00:00', 1183, 'Living Room', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0002', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C001', '2026-07-29T16:02:01+00:00', '2026-07-29T16:11:24+00:00', 563, 'Living Room', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0003', 'TAG02', 'SALE002', 'P001', 'PLAN01', NULL, '2026-07-29T13:28:37+00:00', '2026-07-29T13:50:36+00:00', 1319, 'Entrance', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0004', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C002', '2026-07-30T14:09:13+00:00', '2026-07-30T14:35:11+00:00', 1558, 'Entrance', 'ยกเลิกการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0005', 'TAG02', 'SALE002', 'P001', 'PLAN01', NULL, '2026-07-30T09:46:29+00:00', '2026-07-30T10:26:05+00:00', 2376, 'Entrance', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0006', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C004', '2026-07-31T15:36:12+00:00', '2026-07-31T16:27:17+00:00', 3065, 'Entrance', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0007', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C006', '2026-07-31T13:55:06+00:00', '2026-07-31T14:35:09+00:00', 2403, 'Living Room', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0008', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C005', '2026-08-01T11:34:46+00:00', '2026-08-01T11:54:28+00:00', 1182, 'Living Room', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0009', 'TAG01', 'SALE001', 'P001', 'PLAN01', NULL, '2026-08-01T15:53:49+00:00', '2026-08-01T16:00:38+00:00', 409, 'Living Room', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0010', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C008', '2026-08-01T14:04:13+00:00', '2026-08-01T14:45:56+00:00', 2503, 'Kitchen', 'ยกเลิกการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0011', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C007', '2026-08-02T11:16:08+00:00', '2026-08-02T11:35:58+00:00', 1190, 'Bedroom 2', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0012', 'TAG01', 'SALE001', 'P001', 'PLAN01', NULL, '2026-08-02T11:32:31+00:00', '2026-08-02T11:41:43+00:00', 552, 'Entrance', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0013', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C008', '2026-08-02T16:38:04+00:00', '2026-08-02T17:07:20+00:00', 1756, 'Bedroom 1', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0014', 'TAG01', 'SALE001', 'P001', 'PLAN01', NULL, '2026-08-03T10:43:56+00:00', '2026-08-03T11:23:35+00:00', 2379, 'Kitchen', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0015', 'TAG02', 'SALE002', 'P001', 'PLAN01', NULL, '2026-08-03T16:10:29+00:00', '2026-08-03T16:13:42+00:00', 193, 'Kitchen', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0016', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C006', '2026-08-04T14:53:40+00:00', '2026-08-04T15:31:19+00:00', 2259, 'Bedroom 2', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0017', 'TAG01', 'SALE001', 'P001', 'PLAN01', NULL, '2026-08-04T15:31:01+00:00', '2026-08-04T15:41:39+00:00', 638, 'Kitchen', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0018', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C008', '2026-08-05T09:15:56+00:00', '2026-08-05T09:57:39+00:00', 2503, 'Entrance', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0019', 'TAG01', 'SALE001', 'P001', 'PLAN01', NULL, '2026-08-06T17:35:10+00:00', '2026-08-06T17:56:15+00:00', 1265, 'Bedroom 2', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0020', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C008', '2026-08-07T14:25:42+00:00', '2026-08-07T15:25:45+00:00', 3603, 'Living Room', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0021', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C001', '2026-08-08T09:04:45+00:00', '2026-08-08T09:50:49+00:00', 2764, 'Entrance', 'ยกเลิกการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0022', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C004', '2026-08-09T13:34:08+00:00', '2026-08-09T14:26:30+00:00', 3142, 'Bedroom 2', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0023', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C001', '2026-08-10T10:42:27+00:00', '2026-08-10T11:09:38+00:00', 1631, 'Bedroom 1', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0024', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C004', '2026-08-11T09:25:46+00:00', '2026-08-11T09:51:55+00:00', 1569, 'Entrance', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0025', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C002', '2026-08-11T11:17:29+00:00', '2026-08-11T11:37:32+00:00', 1203, 'Entrance', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0026', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C008', '2026-08-11T10:59:48+00:00', '2026-08-11T11:18:56+00:00', 1148, 'Living Room', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0027', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C008', '2026-08-12T09:24:16+00:00', '2026-08-12T10:14:58+00:00', 3042, 'Living Room', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0028', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C003', '2026-08-13T15:03:03+00:00', '2026-08-13T15:45:55+00:00', 2572, 'Bedroom 1', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0029', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C004', '2026-08-13T10:43:55+00:00', '2026-08-13T11:02:58+00:00', 1143, 'Bedroom 1', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0030', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C005', '2026-08-14T16:42:37+00:00', '2026-08-14T17:24:12+00:00', 2495, 'Bedroom 2', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0031', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C002', '2026-08-14T16:08:42+00:00', '2026-08-14T17:04:00+00:00', 3318, 'Living Room', 'ปิดการขาย') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0032', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C008', '2026-08-15T15:56:04+00:00', '2026-08-15T16:15:44+00:00', 1180, 'Kitchen', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0033', 'TAG01', 'SALE001', 'P001', 'PLAN01', 'C002', '2026-08-16T14:59:42+00:00', '2026-08-16T15:09:46+00:00', 604, 'Living Room', '') ON CONFLICT (visit_key) DO NOTHING;
INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, customer_id, started_at, ended_at, duration_sec, zone, deal_status) VALUES ('V-DEMO-0034', 'TAG02', 'SALE002', 'P001', 'PLAN01', 'C005', '2026-08-16T14:38:13+00:00', '2026-08-16T15:30:12+00:00', 3119, 'Kitchen', '') ON CONFLICT (visit_key) DO NOTHING;

-- Keep analytics able to exclude deterministic demo history from physical
-- hardware records even when this seed is applied to an existing database.
UPDATE visits
SET source = 'simulator'
WHERE visit_key LIKE 'V-DEMO-%';

-- ---------------------------------------------------- notes
INSERT INTO notes (visit_key, user_id, body, created_at, seed_key) VALUES ('V-DEMO-0016', 'u-sale', 'ขอเอกสารสินเชื่อไปศึกษาเพิ่มเติม', now(), 'SEED-NOTE-0001') ON CONFLICT (seed_key) DO NOTHING;
INSERT INTO notes (visit_key, user_id, body, created_at, seed_key) VALUES ('V-DEMO-0021', 'u-sale', 'นัดกลับมาดูอีกรอบพร้อมครอบครัว', now(), 'SEED-NOTE-0002') ON CONFLICT (seed_key) DO NOTHING;
INSERT INTO notes (visit_key, user_id, body, created_at, seed_key) VALUES ('V-DEMO-0028', 'u-sale', 'นัดกลับมาดูอีกรอบพร้อมครอบครัว', now(), 'SEED-NOTE-0003') ON CONFLICT (seed_key) DO NOTHING;

