import { DAY_NAMES } from '../../shared/access.js';

/** The open/closed shape the client renders. Safe to expose publicly. */
export function publicStatus(config, access) {
  return {
    open: access.open,
    reason: access.reason,
    serviceDate: access.serviceDate,
    nextOpenDate: access.nextOpenDate,
    nextOpenDay: access.nextOpenDate
      ? DAY_NAMES[new Date(`${access.nextOpenDate}T12:00:00Z`).getUTCDay()]
      : null,
    message: access.open ? null : config.closedMessage,
    openDays: config.allowedDays.map((d) => DAY_NAMES[d]),
  };
}
