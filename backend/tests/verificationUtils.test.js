const test = require('node:test');
const assert = require('node:assert/strict');
const { rankEvidence, summarizeEvidence } = require('../src/utils/verificationUtils');

test('rankEvidence gives higher priority to reputable sources and relevant matches', async () => {
  const claim = 'The company reported revenue growth of 18% in 2024.';
  const evidence = [
    {
      title: 'Local blog discusses company growth',
      link: 'https://exampleblog.com/company-growth',
      snippet: 'The company had a strong year.',
    },
    {
      title: 'Reuters reports 18% revenue growth for the company in 2024',
      link: 'https://www.reuters.com/2024/01/15/company-revenue-growth',
      snippet: 'The company reported revenue growth of 18% in 2024, according to Reuters.',
    },
  ];

  const ranked = await rankEvidence(evidence, claim);

  assert.equal(ranked[0].link, 'https://www.reuters.com/2024/01/15/company-revenue-growth');
  assert.ok(ranked[0].reliabilityScore > ranked[1].reliabilityScore);
  assert.match(summarizeEvidence(ranked), /Reuters/);
});
 