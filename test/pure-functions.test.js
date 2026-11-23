/**
 * Unit tests for pure / near-pure functions from CareCall src/ modules.
 */

import { describe, it, expect } from 'vitest';
import { genCode, escHtml, _haversine, _toIsoDate } from './extract.js';
import { _nextOccurrence, _upcomingDosesFor } from '../src/medications.js';
import { _authPasswordStrength } from '../src/auth.js';

// ───────────────────────────────────────────────────────────
//  genCode
// ───────────────────────────────────────────────────────────
describe('genCode', () => {
  it('returns a string of default length 6', () => {
    const code = genCode();
    expect(code).toHaveLength(6);
  });

  it('respects custom length', () => {
    expect(genCode(10)).toHaveLength(10);
    expect(genCode(1)).toHaveLength(1);
    expect(genCode(20)).toHaveLength(20);
  });

  it('only uses allowed characters (no O, 0, I, 1)', () => {
    const allowed = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 50; i++) {
      const code = genCode(12);
      for (const ch of code) {
        expect(allowed).toContain(ch);
      }
    }
  });

  it('does not produce the same code on consecutive calls', () => {
    const codes = new Set();
    for (let i = 0; i < 100; i++) codes.add(genCode());
    expect(codes.size).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────
//  escHtml
// ───────────────────────────────────────────────────────────
describe('escHtml', () => {
  it('escapes < > & "', () => {
    expect(escHtml('<b>"hi"&bye</b>')).toBe('&lt;b&gt;&quot;hi&quot;&amp;bye&lt;/b&gt;');
  });

  it('returns empty string for null / undefined / false / 0 / empty', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
    expect(escHtml(false)).toBe('');
    expect(escHtml(0)).toBe('');
    expect(escHtml('')).toBe('');
  });

  it('& becomes &amp;', () => {
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  it('handles a plain safe string unchanged', () => {
    expect(escHtml('hello')).toBe('hello');
  });
});

// ───────────────────────────────────────────────────────────
//  _haversine
// ───────────────────────────────────────────────────────────
describe('_haversine', () => {
  it('computes Tel Aviv → Jerusalem ≈ 54 km (within 2 km)', () => {
    const d = _haversine(32.0853, 34.7818, 31.7683, 35.2137);
    expect(d).toBeGreaterThan(52000);
    expect(d).toBeLessThan(56000);
  });

  it('same point → 0', () => {
    expect(_haversine(40, -74, 40, -74)).toBe(0);
  });

  it('antipodal points → ~20 000 km (within 500 km)', () => {
    const d = _haversine(90, 0, -90, 0);
    expect(d).toBeGreaterThan(19500000);
    expect(d).toBeLessThan(20500000);
  });
});

// ───────────────────────────────────────────────────────────
//  _toIsoDate
// ───────────────────────────────────────────────────────────
describe('_toIsoDate', () => {
  it('passes through ISO date unchanged', () => {
    expect(_toIsoDate('1945-03-12')).toBe('1945-03-12');
  });

  it('converts DD/MM/YYYY', () => {
    expect(_toIsoDate('12/03/1945')).toBe('1945-03-12');
  });

  it('converts DD.MM.YYYY', () => {
    expect(_toIsoDate('12.03.1945')).toBe('1945-03-12');
  });

  it('converts English date "March 12, 1945"', () => {
    expect(_toIsoDate('March 12, 1945')).toBe('1945-03-12');
  });

  it('returns "" for null / undefined / empty / garbage', () => {
    expect(_toIsoDate(null)).toBe('');
    expect(_toIsoDate(undefined)).toBe('');
    expect(_toIsoDate('')).toBe('');
    expect(_toIsoDate('not a date')).toBe('');
  });
});

// ───────────────────────────────────────────────────────────
//  _authPasswordStrength
// ───────────────────────────────────────────────────────────
describe('_authPasswordStrength', () => {
  it('returns "" for empty / falsy', () => {
    expect(_authPasswordStrength('')).toBe('');
    expect(_authPasswordStrength(null)).toBe('');
    expect(_authPasswordStrength(undefined)).toBe('');
  });

  it('returns "weak" for short passwords (< 8 chars)', () => {
    expect(_authPasswordStrength('Ab1!')).toBe('weak');
    expect(_authPasswordStrength('1234567')).toBe('weak');
  });

  it('returns "weak" for 8 chars with letters only', () => {
    expect(_authPasswordStrength('abcdefgh')).toBe('weak');
  });

  it('returns "fair" for 8 chars with letters + digits', () => {
    expect(_authPasswordStrength('abcdef12')).toBe('fair');
  });

  it('returns "strong" for 12+ chars with letters + digits', () => {
    expect(_authPasswordStrength('abcdefgh1234')).toBe('strong');
  });

  it('returns "strong" for 12+ chars with letters + digits + special', () => {
    expect(_authPasswordStrength('abcdefgh12!@')).toBe('strong');
  });
});

// ───────────────────────────────────────────────────────────
//  _nextOccurrence
// ───────────────────────────────────────────────────────────
describe('_nextOccurrence', () => {
  it('returns today at the given time if it has not passed yet', () => {
    const from = new Date(2025, 0, 15, 7, 0, 0);
    const result = _nextOccurrence('08:00', from);
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(8);
  });

  it('returns tomorrow if the time already passed today', () => {
    const from = new Date(2025, 0, 15, 9, 0, 0);
    const result = _nextOccurrence('08:00', from);
    expect(result.getDate()).toBe(16);
    expect(result.getHours()).toBe(8);
  });

  it('skips disallowed days', () => {
    const from = new Date(2025, 0, 15, 7, 0, 0); // Wed
    const result = _nextOccurrence('06:00', from, [1, 3, 5]);
    expect([1, 3, 5]).toContain(result.getDay());
    expect(result > from).toBe(true);
  });

  it('returns null for invalid timeStr', () => {
    const from = new Date();
    expect(_nextOccurrence('invalid', from)).toBeNull();
    expect(_nextOccurrence('', from)).toBeNull();
    expect(_nextOccurrence(null, from)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  _upcomingDosesFor
// ───────────────────────────────────────────────────────────
describe('_upcomingDosesFor', () => {
  const BASE = new Date(2025, 0, 15, 7, 0, 0);

  it('fixed_times med with 2 times → 2 sorted dates', () => {
    const med = { enabled: true, prn: false, schedule: { kind: 'fixed_times', times: ['08:00', '20:00'] } };
    const doses = _upcomingDosesFor(med, BASE);
    expect(doses).toHaveLength(2);
    expect(doses[0] < doses[1]).toBe(true);
  });

  it('interval med every 6h → ~3–4 doses in 24h', () => {
    const med = { enabled: true, prn: false, schedule: { kind: 'interval', anchor: '08:00', interval_hours: 6 } };
    const doses = _upcomingDosesFor(med, BASE);
    expect(doses.length).toBeGreaterThanOrEqual(3);
    expect(doses.length).toBeLessThanOrEqual(4);
  });

  it('PRN med → empty array', () => {
    const med = { enabled: true, prn: true, schedule: { kind: 'fixed_times', times: ['08:00'] } };
    expect(_upcomingDosesFor(med, BASE)).toEqual([]);
  });

  it('disabled med → empty array', () => {
    const med = { enabled: false, prn: false, schedule: { kind: 'fixed_times', times: ['08:00'] } };
    expect(_upcomingDosesFor(med, BASE)).toEqual([]);
  });

  it('days_of_week on wrong day → doses land on allowed days', () => {
    const med = { enabled: true, prn: false, schedule: { kind: 'days_of_week', times: ['10:00'], days: [1, 5] } };
    const doses = _upcomingDosesFor(med, BASE);
    for (const d of doses) {
      expect([1, 5]).toContain(d.getDay());
    }
  });
});

// ───────────────────────────────────────────────────────────
//  carer priority sort logic
// ───────────────────────────────────────────────────────────
describe('carer priority sort logic', () => {
  function sortCarers(carers, priorityOrder) {
    return carers.slice().sort((a, b) => {
      const ai = priorityOrder.indexOf(a.uid);
      const bi = priorityOrder.indexOf(b.uid);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  it('sorts by priority order', () => {
    const carers = [
      { uid: 'c', name: 'Charlie', availability: 'available' },
      { uid: 'a', name: 'Alice', availability: 'available' },
      { uid: 'b', name: 'Bob', availability: 'available' },
    ];
    const result = sortCarers(carers, ['a', 'b', 'c']);
    expect(result.map(c => c.uid)).toEqual(['a', 'b', 'c']);
  });

  it('prioritised carers come before unprioritised', () => {
    const carers = [
      { uid: 'x', name: 'Xena', availability: 'available' },
      { uid: 'a', name: 'Alice', availability: 'available' },
    ];
    const result = sortCarers(carers, ['a']);
    expect(result[0].uid).toBe('a');
  });

  it('unprioritised carers sort alphabetically', () => {
    const carers = [
      { uid: 'z', name: 'Zara', availability: 'available' },
      { uid: 'm', name: 'Mike', availability: 'available' },
    ];
    const result = sortCarers(carers, []);
    expect(result[0].name).toBe('Mike');
    expect(result[1].name).toBe('Zara');
  });

  it('handles empty list', () => {
    expect(sortCarers([], ['a', 'b'])).toEqual([]);
  });
});
