import { describe, expect, it } from 'vitest';
import { parseCourses } from './parse.js';

function book(assignment: Record<string, unknown>) {
  return {
    courses: [
      {
        title: 'AL 6th Grade Science',
        marks: [{ calculatedScoreString: 'A', calculatedScoreRaw: '3.7', assignments: [assignment] }],
      },
    ],
  };
}

function pointsPossibleOf(assignment: Record<string, unknown>): number | undefined {
  return parseCourses(book(assignment), null, 0)[0]!.marks[0]!.assignments[0]!.pointsPossible;
}

describe('points possible', () => {
  it('prefers the numeric pointPossible field', () => {
    expect(pointsPossibleOf({ measure: 'Quiz', pointPossible: 25, points: '23 / 25' })).toBe(25);
  });

  it('reads the points display string', () => {
    expect(pointsPossibleOf({ measure: 'Quiz', points: '23 / 25' })).toBe(25);
    expect(pointsPossibleOf({ measure: 'Quiz', points: '10 Points Possible' })).toBe(10);
    expect(pointsPossibleOf({ measure: 'Quiz', points: '4' })).toBe(4);
  });

  // The rubric case the ParentVUE app shows as "3.5 out of 4" while the feed
  // leaves pointPossible null and points empty.
  it('falls back to displayScore when the points fields are empty', () => {
    expect(
      pointsPossibleOf({
        measure: 'Launch Unit Quiz 1',
        score: '3.5',
        displayScore: '3.5 out of 4',
        points: '',
        point: null,
        pointPossible: null,
      }),
    ).toBe(4);
    expect(pointsPossibleOf({ measure: 'Quiz', displayScore: '3.5 / 4' })).toBe(4);
  });

  it('falls back to a rubric score type', () => {
    expect(pointsPossibleOf({ measure: 'Lab', scoreType: 'Rubric 0 - 4', displayScore: 'Not Graded' })).toBe(4);
  });

  it('ignores a zero points field when another source has a real total', () => {
    expect(pointsPossibleOf({ measure: 'Quiz', pointPossible: 0, displayScore: '3.5 out of 4' })).toBe(4);
  });

  it('leaves points possible unset when nothing carries it', () => {
    expect(pointsPossibleOf({ measure: 'Quiz', displayScore: 'Not Graded', scoreType: 'Raw Score' })).toBeUndefined();
  });

  it('does not mistake the score for the total', () => {
    expect(pointsPossibleOf({ measure: 'Quiz', score: '3.5', displayScore: '3.5' })).toBeUndefined();
  });
});
