import type pg from 'pg'
import { WorkflowError, type Scope, type Window } from './workflow-types.ts'

const zipCenters: Record<string, [number, number]> = {
  '33125': [25.783, -80.233], '33126': [25.778, -80.299], '33127': [25.813, -80.205],
  '33128': [25.777, -80.203], '33130': [25.765, -80.204], '33133': [25.731, -80.240],
  '33134': [25.755, -80.270], '33135': [25.767, -80.236], '33142': [25.812, -80.235],
  '33155': [25.735, -80.310], '33165': [25.734, -80.359], '33010': [25.833, -80.278],
}
export const venueZips = Object.keys(zipCenters).sort()

export async function seedVenues(client: pg.PoolClient, tenantId: string) {
  await client.query(`
    INSERT INTO venue_rooms
      (tenant_id, id, venue, room, zip, latitude, longitude, capacity, opens, closes, amenities, demo_hold)
    VALUES
      ($1, 'grove', 'Grove Learning Annex', 'Mangrove Room', '33133', 25.731, -80.241, 42, '08:00', '20:00', ARRAY['projector','wifi','accessible'], false),
      ($1, 'river', 'Riverbend Learning Center', 'River Room', '33135', 25.767, -80.236, 55, '08:00', '20:00', ARRAY['projector','wifi'], false),
      ($1, 'occupied', 'Coral Community Hub', 'Coral Room', '33134', 25.751, -80.270, 50, '08:00', '20:00', ARRAY['projector','wifi'], true),
      ($1, 'small', 'Grove Learning Annex', 'Cove Room', '33133', 25.731, -80.241, 14, '08:00', '20:00', ARRAY['projector'], false),
      ($1, 'unequipped', 'Biscayne Neighborhood Center', 'Bay Room', '33130', 25.765, -80.205, 45, '08:00', '20:00', ARRAY['wifi','accessible'], false)
    ON CONFLICT DO NOTHING
  `, [tenantId])
}

type Room = {
  id: string; venue: string; room: string; capacity: number; amenities: string[]
  latitude: number; longitude: number; occupied: boolean; in_hours: boolean
}
export type Criteria = { zip: string; radius: number; capacity: number; required: string[]; preferred: string[] }
export async function searchRooms(client: pg.PoolClient, scope: Scope, requestId: string, window: Window, criteria: Criteria) {
  const center = zipCenters[criteria.zip]
  if (!center || !Number.isInteger(criteria.capacity) || criteria.capacity < 1 || criteria.radius < 1 || criteria.radius > 50) {
    throw new WorkflowError('Choose a catalog ZIP, a 1–50 mile radius, and a positive headcount.', 400)
  }
  const { rows } = await client.query<Room>(`
    SELECT v.*, v.demo_hold OR EXISTS (
      SELECT 1 FROM room_reservations r WHERE r.tenant_id = v.tenant_id AND r.room_id = v.id
        AND r.request_id <> $2 AND r.starts_at < $4 AND r.ends_at > $3
    ) AS occupied,
    ($3::timestamptz AT TIME ZONE $5)::date = ($4::timestamptz AT TIME ZONE $5)::date
      AND ($3::timestamptz AT TIME ZONE $5)::time >= v.opens
      AND ($4::timestamptz AT TIME ZONE $5)::time <= v.closes AS in_hours
    FROM venue_rooms v WHERE v.tenant_id = $1
  `, [scope.id, requestId, window.start, window.end, scope.timezone])
  return rows.map(room => {
    const north = (room.latitude - center[0]) * 69
    const east = (room.longitude - center[1]) * 69 * Math.cos(center[0] * Math.PI / 180)
    const distance = Math.hypot(north, east)
    const reasons = [
      ...(distance > criteria.radius ? ['Outside radius'] : []),
      ...(room.capacity < criteria.capacity ? ['Too small'] : []),
      ...(criteria.required.some(item => !room.amenities.includes(item)) ? ['Missing required equipment'] : []),
      ...(!room.in_hours ? ['Outside opening hours'] : []),
      ...(room.occupied ? ['Occupied'] : []),
    ]
    return { ...room, distance, reasons, preference: criteria.preferred.filter(item => room.amenities.includes(item)).length }
  }).sort((a, b) => Number(Boolean(a.reasons.length)) - Number(Boolean(b.reasons.length))
    || (a.distance - a.preference * 0.5) - (b.distance - b.preference * 0.5) || a.id.localeCompare(b.id))
}

export async function reserveRoom(client: pg.PoolClient, scope: Scope, requestId: string, window: Window,
  criteria: Criteria, roomId: string) {
  await client.query('SELECT id FROM venue_rooms WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.id, roomId])
  const room = (await searchRooms(client, scope, requestId, window, criteria)).find(item => item.id === roomId)
  if (!room || room.reasons.length) throw new WorkflowError(`Room unavailable: ${room?.reasons.join(', ') ?? 'room not found'}.`)
  await client.query(`
    INSERT INTO room_reservations (tenant_id, request_id, room_id, starts_at, ends_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, request_id) DO UPDATE SET room_id = EXCLUDED.room_id,
      starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at
  `, [scope.id, requestId, roomId, window.start, window.end])
  return `${room.venue} · ${room.room} (simulated)`
}
