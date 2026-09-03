# Database rollback scripts

Rollback scripts are intentionally kept outside `database/migrations` so the
ordered migration runner cannot apply them by accident.

Before running a rollback against staging or production:

1. Take and verify a database snapshot.
2. Rehearse the migration and rollback on a recent restored copy.
3. Roll back the application version before removing its required columns.
4. Run the matching script in a maintenance window.
5. Verify the backup tables created by the script before dropping them.

`005_plan_editor_freeform.sql` preserves the removed values in
`rollback_005_plans`, `rollback_005_zones`, and `rollback_005_anchors`.
