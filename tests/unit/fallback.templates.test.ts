import { emailTemplates } from '@/providers/email/email.templates';

/**
 * The fallback email now covers care events that are not medication, so the
 * wording has to stop assuming a dose. These assertions are about the words a
 * patient actually reads.
 */
describe('fallback email templates', () => {
  const medication = emailTemplates.medicationFallback('Metformin', '15 June 2026, 08:00');
  const care = emailTemplates.careReminderFallback('Antenatal visit — week 20', '18 June 2026, 09:00');

  it('leaves the medication email saying what it always said', () => {
    expect(medication).toContain('Metformin');
    expect(medication).toContain('pending dose');
    expect(medication).toContain('Please take your medication');
  });

  it('never tells someone to take an antenatal visit', () => {
    expect(care).not.toMatch(/take your medication/i);
    expect(care).not.toMatch(/pending dose/i);
    expect(care).not.toMatch(/dose/i);
  });

  it('names the event and when it was scheduled', () => {
    expect(care).toContain('Antenatal visit — week 20');
    expect(care).toContain('18 June 2026, 09:00');
  });

  it('keeps the same shell as the medication email', () => {
    for (const fragment of ['Vitals', 'Open Vitals', 'All rights reserved']) {
      expect(care).toContain(fragment);
    }
  });

  it('renders a complete document', () => {
    expect(care.trim().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(care).toContain('</html>');
  });
});
