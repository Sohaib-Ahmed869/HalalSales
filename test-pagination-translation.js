// test-pagination-translation.js
// Test script to demonstrate pagination text translation

const translationService = require('./services/translationService');

async function testPaginationTranslation() {
  console.log('🧪 Testing Pagination Text Translation\n');

  const testTexts = [
    '10 per page',
    '25 per page',
    '50 per page',
    '100 per page',
    'Showing 1 to 10 of 100 results',
    'Showing 11-20 of 100',
    'Display 1 to 25 of 500',
    'Page 1 of 10',
    'Page 5 of 20',
    '20 items per page',
    '30 results per page',
    '40 entries per page',
    'Viewing 1 to 15 of 300',
    'Regular text without numbers',
    'Another normal text'
  ];

  console.log('📝 Test texts:');
  testTexts.forEach((text, index) => {
    console.log(`  ${index + 1}. "${text}"`);
  });

  console.log('\n🔍 Pagination text detection:');
  testTexts.forEach((text, index) => {
    const isPagination = translationService.isPaginationText(text);
    console.log(`  ${index + 1}. "${text}" → ${isPagination ? '✅ Pagination' : '❌ Not pagination'}`);
  });

  console.log('\n📋 Template generation:');
  testTexts.forEach((text, index) => {
    if (translationService.isPaginationText(text)) {
      const template = translationService.getPaginationTemplate(text);
      console.log(`  ${index + 1}. "${text}" → "${template}"`);
    }
  });

  console.log('\n🌍 Translation simulation (FR):');
  const paginationTexts = testTexts.filter(text => translationService.isPaginationText(text));
  
  try {
    const result = await translationService.translatePaginationText(paginationTexts, 'FR', 'EN');
    
    if (result.success) {
      console.log('✅ Translation successful!');
      console.log('📊 Results:');
      paginationTexts.forEach((original, index) => {
        const translation = result.translations[index];
        console.log(`  ${index + 1}. "${original}" → "${translation.text}"`);
      });
      console.log(`\n📝 Reason: ${result.reason}`);
    } else {
      console.log('❌ Translation failed:', result.error);
    }
  } catch (error) {
    console.error('❌ Error during translation:', error.message);
  }

  console.log('\n🎯 Key Benefits:');
  console.log('  • Numbers are preserved as placeholders');
  console.log('  • Pagination text always returns English templates');
  console.log('  • Frontend can substitute actual values using t() function');
  console.log('  • No more "nombre de PLACEMENTS per page" issues');
  console.log('  • Consistent behavior across all languages');
}

// Run the test
testPaginationTranslation().catch(console.error);
