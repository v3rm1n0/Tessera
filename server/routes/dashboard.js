import { Router } from 'express';
import { db, resetBoundary } from '../db.js';
import { requireRole, requireEventAccess, requireSectionAccess } from '../auth.js';

/** Dashboard data for event admins/scanners only; the owner has no access to day-to-day statistics. */
export const dashboardRouter = Router();
const eventRoles = requireRole('EVENT_ADMIN', 'SCANNER');

dashboardRouter.get('/events/:eventId/dashboard', eventRoles, requireEventAccess, (req, res) => {
  const since = resetBoundary(req.event.reset_time, undefined, req.event.timezone);
  const sections = db.prepare(`
    SELECT s.id, s.name, s.color,
           (SELECT COUNT(*) FROM tickets t WHERE t.section_id = s.id) AS ticket_count,
           (SELECT COUNT(*) FROM scans sc
             WHERE sc.section_id = s.id AND sc.result = 'OK' AND sc.voided_at IS NULL AND sc.scanned_at >= ?) AS scans_today,
           (SELECT COUNT(DISTINCT sc.ticket_uuid) FROM scans sc
             WHERE sc.section_id = s.id AND sc.result = 'DOUBLE' AND sc.voided_at IS NULL AND sc.scanned_at >= ?) AS doubles_today,
           (SELECT json_group_array(json_object(
                'id', sub.id, 'name', sub.name,
                'ticket_count', (SELECT COUNT(*) FROM tickets t WHERE t.subsection_id = sub.id),
                'scans_today', (SELECT COUNT(*) FROM scans sc JOIN tickets t ON t.uuid = sc.ticket_uuid
                  WHERE t.subsection_id = sub.id AND sc.result = 'OK' AND sc.voided_at IS NULL
                    AND sc.scanned_at >= ?))
                ORDER BY sub.name COLLATE NOCASE)
             FROM subsections sub WHERE sub.section_id = s.id) AS subsections
    FROM sections s WHERE s.event_id = ? ORDER BY s.name
  `).all(since, since, since, req.event.id)
    .map(s => ({ ...s, subsections: JSON.parse(s.subsections) }));

  res.json({
    event: { id: req.event.id, name: req.event.name, reset_time: req.event.reset_time, timezone: req.event.timezone },
    reset_boundary: since,
    total_sections: sections.length,
    total_scans_today: sections.reduce((sum, s) => sum + s.scans_today, 0),
    sections,
  });
});

/** Detail view: double-scanned codes of a section since the last reset. */
dashboardRouter.get('/sections/:sectionId/doubles', eventRoles, requireSectionAccess, (req, res) => {
  const since = resetBoundary(req.event.reset_time, undefined, req.event.timezone);
  const doubles = db.prepare(`
    SELECT sc.ticket_uuid AS uuid,
           sub.name AS subsection,
           COUNT(*) AS attempts,
           MAX(sc.scanned_at) AS last_attempt_at
    FROM scans sc
    JOIN tickets t ON t.uuid = sc.ticket_uuid
    LEFT JOIN subsections sub ON sub.id = t.subsection_id
    WHERE sc.section_id = ? AND sc.result = 'DOUBLE' AND sc.voided_at IS NULL AND sc.scanned_at >= ?
    GROUP BY sc.ticket_uuid
    ORDER BY last_attempt_at DESC
  `).all(req.section.id, since);
  res.json({
    section: { id: req.section.id, name: req.section.name },
    doubles,
  });
});
