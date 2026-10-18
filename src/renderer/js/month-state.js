import { currentMonth } from './format.js';

// The month being looked at, shared by the Purchases and Monthly Report pages
// so switching between them keeps the same month.
let viewed = null;

export function getViewedMonth() {
  return viewed || currentMonth();
}

export function setViewedMonth(month) {
  viewed = month;
}
