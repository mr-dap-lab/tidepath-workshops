import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, proposeIntake } from '../src/intake.ts'

test('the simulated email yields one draft covering every missing field', () => {
  const result = proposeIntake(fixture.body)
  assert.equal(result.details.correspondence_language, 'English')
  assert.equal(result.details.workshop_language, 'Spanish')
  assert.deepEqual(result.missingFields, ['Headcount', 'Availability', 'Room logistics'])
  assert.deepEqual(result.proposedFollowUp?.match(/^- .+$/gm), [
    '- How many students do you expect?',
    '- Which dates and times work for your group?',
    '- Can you host at the school, or should we look for a room? Please share any equipment or accessibility needs.',
  ])
})

test('a complete virtual request needs no follow-up', () => {
  const body = fixture.body.replace('Format: In person', 'Format: Virtual') +
    '\nHeadcount: 30\nAvailability: Monday mornings\nVirtual logistics: The school will host.'
  const result = proposeIntake(body)
  assert.deepEqual(result.missingFields, [])
  assert.equal(result.proposedFollowUp, null)
})
