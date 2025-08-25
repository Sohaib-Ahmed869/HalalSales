# Pagination Text Translation System

## Problem Solved

The previous translation system was translating pagination text like "10 per page" to hardcoded values like "nombre de PLACEMENTS per page", which broke the frontend's ability to handle dynamic values properly.

## Solution

This system automatically detects pagination text and returns English templates with placeholders instead of translated strings with substituted values.

## How It Works

### 1. Automatic Detection
The system automatically detects pagination text using patterns like:
- `10 per page` → `{count} per page`
- `Showing 1 to 10 of 100 results` → `Showing {from} to {to} of {total} results`
- `Page 1 of 5` → `Page {current} of {total}`

### 2. Template Generation
Instead of translating "10 per page" to French, it returns `{count} per page` as a template.

### 3. Frontend Usage
The frontend can then use the `t()` function to substitute actual values:
```javascript
// Backend returns: "{count} per page"
// Frontend uses: t('{count} per page', { count: 25 })
// Result: "25 per page"
```

## API Endpoints

### 1. Dedicated Pagination Endpoint
```http
POST /api/translation/translate-pagination
Content-Type: application/json

{
  "texts": ["10 per page", "Showing 1 to 10 of 100 results"],
  "targetLang": "FR",
  "sourceLang": "EN"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "translations": [
      { "text": "{count} per page" },
      { "text": "Showing {from} to {to} of {total} results" }
    ],
    "targetLanguage": "FR",
    "sourceLanguage": "EN"
  },
  "message": "Successfully processed pagination texts for FR"
}
```

### 2. Automatic UI Translation
The existing `/api/translation/translate-ui` endpoint now automatically detects pagination text and handles it specially.

## Supported Patterns

| Input Pattern | Template Output |
|---------------|-----------------|
| `10 per page` | `{count} per page` |
| `25 results per page` | `{count} per page` |
| `Showing 1 to 10 of 100 results` | `Showing {from} to {to} of {total} results` |
| `Page 1 of 5` | `Page {current} of {total}` |
| `Display 1-25 of 500` | `Display {from} to {to} of {total}` |
| `Viewing 1 to 15 of 300` | `Viewing {from} to {to} of {total}` |

## Frontend Integration

### Before (Broken):
```javascript
// Backend returned: "nombre de PLACEMENTS per page"
// Frontend couldn't substitute the actual count
```

### After (Fixed):
```javascript
// Backend returns: "{count} per page"
// Frontend can substitute:
const translatedText = t('{count} per page', { count: 25 });
// Result: "25 per page" (in user's language)
```

## Benefits

1. **Numbers Preserved**: Numbers are never translated, only converted to placeholders
2. **Consistent Behavior**: Same logic across all languages
3. **Frontend Control**: Frontend handles parameter substitution
4. **No More Hardcoded Values**: No more "nombre de PLACEMENTS per page"
5. **Better Caching**: Translation templates can be cached properly
6. **Dynamic Values**: Frontend can substitute actual pagination values

## Testing

Run the test script to see it in action:
```bash
node test-pagination-translation.js
```

## Migration Guide

### For Frontend Developers:
1. Use the new `/api/translation/translate-pagination` endpoint for pagination text
2. Handle the returned templates with placeholders
3. Use `t()` function for parameter substitution

### For Backend Developers:
1. The system automatically detects pagination text
2. No changes needed to existing translation calls
3. Pagination text will automatically return templates instead of translated values

## Configuration

No additional configuration needed. The system automatically:
- Detects pagination text patterns
- Converts them to English templates
- Preserves numbers as placeholders
- Works with all supported languages

## Error Handling

If translation fails, the system falls back to returning pagination templates, ensuring the frontend always receives usable text with placeholders.
