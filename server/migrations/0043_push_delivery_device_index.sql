-- Queueing a nudge first checks whether the device already has one waiting (a nudge is a
-- wake-up; one is enough), which looks deliveries up by device and status.
CREATE INDEX IF NOT EXISTS idx_push_deliveries_device_status ON push_deliveries(device_id, status);
