/**
 * The sentence somebody pastes to their assistant.
 *
 * On the front page and on the make-one page, and in one place, because the
 * model reads whichever page was pasted and the two must not tell it different
 * things. The bracketed part is the person's to change; everything else is what makes
 * the answer a DAI file rather than a guess.
 */
export const PROMPT =
  'Make me a DAI app for [a packing list for our beach trip]. ' +
  'Follow the recipe at https://www.dynamicapplicationinterface.io/docs/the-recipe';

/** Things a person might put in the brackets. */
export const IDEAS = [
  'a packing list for our beach trip',
  'a chore chart for the kids',
  'a reading log for Maya',
  "a budget for Leo's birthday party",
  'our weekly dinner plan',
  'a plant-watering schedule',
];
