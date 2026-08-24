# Not read by the running app

These JSON files are kept for reference only — they're what the very
first version of this project used to configure zones/anchors/people
before it moved to a database. The backend now reads all of this from
Postgres instead (see `../../database/schema.sql` and
`../../database/seed.sql`):

| This file        | Now lives in                                    |
|-------------------|--------------------------------------------------|
| `zones.json`      | the `zones` table, scoped per project             |
| `anchors.json`    | the `anchors` table, scoped per project           |
| `people.json`     | the `users` table                                 |
| `projects.json`   | the `projects` table                              |

Editing these files won't change what the app shows. To change zones
or anchors, use `POST /api/projects/{id}/anchors` or edit the tables
directly; to add more demo employees/visits, see
`scripts/generate_seed.py` (regenerates `database/seed.sql`).
