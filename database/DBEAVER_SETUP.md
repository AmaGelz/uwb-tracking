# ตั้งค่า PostgreSQL และ DBeaver

โปรเจกต์นี้ไม่เชื่อมฐานข้อมูล "ผ่าน" DBeaver โดยตรง โครงสร้างที่ใช้คือ:

```text
เว็บ / อุปกรณ์ UWB -> FastAPI -> PostgreSQL
                              ^
                              |
                           DBeaver
```

DBeaver เป็นโปรแกรมสำหรับสร้าง ตรวจสอบ และแก้ไขข้อมูลใน PostgreSQL เท่านั้น
FastAPI และ DBeaver ต้องเชื่อมไปยัง PostgreSQL instance และ database เดียวกัน

## 1. เตรียมฐานข้อมูลเป้าหมาย

ต้องมี PostgreSQL Server ก่อน เพราะการติดตั้ง DBeaver อย่างเดียวไม่ได้สร้าง
database server ให้ อาจใช้ PostgreSQL บนเครื่อง, เซิร์ฟเวอร์บริษัท หรือ hosted
PostgreSQL ก็ได้

ตัวอย่างค่าสำหรับพัฒนาในเครื่อง:

| DBeaver field | ค่า |
| --- | --- |
| Driver | PostgreSQL |
| Host | `127.0.0.1` |
| Port | `5432` |
| Database | `supalai_test` |
| Username | `postgres` |
| Password | รหัสผ่านของ PostgreSQL ในเครื่อง |

ใน DBeaver เลือก **New Database Connection > PostgreSQL** กรอกค่าข้างบนแล้ว
กด **Test Connection** หากเป็นฐานข้อมูล remote ให้กำหนด SSL ตามนโยบายของ
ผู้ให้บริการด้วย

ค่าชุดนี้เป็นเพียงตัวอย่างสำหรับ local development ใน production ควรสร้าง
user เฉพาะของแอป เช่น `supalai_app` และให้สิทธิ์เฉพาะ database ของแอป

## 2. ตั้งค่า FastAPI ให้ใช้ฐานเดียวกับ DBeaver

คัดลอก `.env.example` เป็น `backend/.env` แล้วแก้ `DATABASE_URL`:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
SEED_DEMO_DATA=true
SIMULATOR_ENABLED=true
```

ตัวอย่าง local ที่ตรงกับตารางด้านบน:

```env
DATABASE_URL=postgresql://postgres:PASSWORD@127.0.0.1:5432/supalai_test
```

ถ้า username หรือ password มีอักขระพิเศษ เช่น `@`, `:`, `/`, `#` ต้องทำ
URL-encode ก่อนใส่ใน `DATABASE_URL` ห้ามนำค่านี้ไปไว้ในไฟล์ JavaScript หรือ
commit `backend/.env` เข้า Git

## 3. สร้าง schema และ migrations

จากโฟลเดอร์รากของโปรเจกต์ รัน:

```powershell
Copy-Item .env.example backend/.env
# แก้ DATABASE_URL ใน backend/.env ให้ตรงกับ connection ใน DBeaver
python -m pip install -r requirements.txt
python migration/migration.py --seed
```

ใช้ `--seed` เฉพาะเมื่อต้องการข้อมูลตัวอย่าง หากเป็น production ให้ตัด
`--seed` ออก และตั้งค่าต่อไปนี้ใน `backend/.env`:

```env
SEED_DEMO_DATA=false
SIMULATOR_ENABLED=false
```

หลัง migration เสร็จ กด **Refresh** ที่ schema `public` ใน DBeaver จะเห็นตาราง
เช่น `users`, `projects`, `anchors`, `tags`, `positions`, `visits` และ
`hardware_ingest_receipts`

## 4. เริ่มระบบและตรวจสอบ

```powershell
Set-Location backend/backend
python main.py
```

เปิด `http://127.0.0.1:8000/health` ค่าที่ถูกต้องควรมี
`"database": "postgres"` จากนั้นตรวจว่าข้อมูลเดียวกันปรากฏใน DBeaver

## 5. ย้ายข้อมูลเดิมจาก Supabase ด้วย DBeaver

1. สร้าง connection ใน DBeaver สำหรับ Supabase ต้นทางและ PostgreSQL ปลายทาง
2. รัน migration ของโปรเจกต์กับปลายทางก่อน เพื่อให้ schema ปลายทางถูกต้อง
3. ที่ connection ต้นทาง เลือกเฉพาะตารางแอปใน schema `public` แล้วใช้
   **Export Data > Database**
4. เลือก connection ปลายทางและโอนเฉพาะข้อมูล ไม่สร้างหรือแทนที่ schema
5. ไม่ย้าย schema ที่ Supabase จัดการ เช่น `auth`, `storage` และ `realtime`
6. รัน `python migration/migration.py` อีกครั้งเพื่อใช้ backfill และ index
   ล่าสุด แล้วตรวจจำนวนแถวและข้อมูลสำคัญก่อน cutover

รหัสผ่านจาก Supabase Auth และ session เดิมไม่สามารถนำมาใช้เป็น FastAPI session
ได้โดยตรง รายละเอียดและข้อควรระวังเพิ่มเติมอยู่ใน
[`MIGRATING_FROM_SUPABASE.md`](MIGRATING_FROM_SUPABASE.md)

## 6. ทางเลือก: ย้ายข้อมูลผ่าน staging ด้วย SQL

หากต้องการควบคุมการย้ายข้อมูลเองและตรวจสอบก่อนเขียนลงตารางจริง:

1. ที่ฐานปลายทาง สร้าง schema ชั่วคราว `supabase_import`
2. ใช้ DBeaver Data Transfer คัดลอกตารางแอปจาก Supabase `public` ไปยัง
   `supabase_import` โดยให้ DBeaver สร้าง staging tables และนำข้อมูลเข้า
3. เปิดและ Execute
   [`../migration/supabase_manual_data_migration.sql`](../migration/supabase_manual_data_migration.sql)
   ด้วย user ที่เป็น owner ของตารางแอปใน `public`
4. ตรวจ row-count summary และทดสอบระบบ
5. เมื่อยืนยันครบแล้วจึงลบ staging ด้วย
   `DROP SCHEMA supabase_import CASCADE`

สคริปต์ไม่ลบข้อมูลปลายทาง ใช้ `ON CONFLICT DO NOTHING` และไม่ย้าย Supabase
Auth, sessions, storage, realtime หรือ hardware-ingest receipts
