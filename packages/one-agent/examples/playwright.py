import asyncio

async def main():
    print('Starting to visit Google and search for "red hairstyle"...')
    
    # 1. Navigate to Google
    print('1. Navigating to Google...')
    await act('playwright_browser_navigate', {'url': 'https://www.google.com'})
    
    # Wait for page to load
    await act('playwright_browser_wait_for', {'time': 2})
    
    # 2. Get page snapshot
    print('2. Getting Google homepage snapshot...')
    snapshot_result = await act('playwright_browser_snapshot', {})
    snapshot_text = snapshot_result['content'][0]['text']
    
    # 3. Use AI to analyze snapshot and find search box element
    print('3. Analyzing page elements, looking for search box...')
    ai_result = await reason(
        'Analyze this webpage snapshot and find the search box ref identifier. This is Google homepage. Return format: {"search_box_ref": "element ref"}' + snapshot_text,
        {'search_box_ref': 'e12'}
    )
    
    search_box_ref = ai_result['data']['search_box_ref']
    print(f'Found search box ref: {search_box_ref}')
    
    # 4. Type "red hairstyle" in search box
    print('4. Typing "red hairstyle" in search box...')
    await act('playwright_browser_type', {
        'ref': search_box_ref,
        'text': 'red hairstyle',
        'submit': True
    })
    
    # 5. Wait for search results to load
    print('5. Waiting for search results to load...')
    await act('playwright_browser_wait_for', {'time': 3})
    
    # 6. Get search results page snapshot
    print('6. Getting search results snapshot...')
    result_snapshot = await act('playwright_browser_snapshot', {})
    result_text = result_snapshot['content'][0]['text']
    
    # 7. Use AI to analyze search results page elements
    print('7. Analyzing search result elements...')
    position_result = await reason(
        'Analyze this search results page snapshot and find the search result elements with their ref identifiers and position information. Return format: {"results": [{"ref": "element ref", "title": "title text", "position": "position description"}]}' + result_text,
        {'results': [{'ref': '#1', 'title': 'Red Hairstyle Gallery', 'position': 'First result at top left'}]}
    )
    
    results = position_result['data']['results']
    
    # 8. Take screenshot
    print('8. Taking screenshot...')
    await act('playwright_browser_take_screenshot', {
        'type': 'png',
        'filename': 'google_search_result.png'
    })
    
    # Output results
    print('\n=== Search Results Analysis ===')
    print(f'Found {len(results)} search results:')
    for i, result in enumerate(results, 1):
        print(f'{i}. Ref: {result["ref"]}')
        print(f'   Title: {result["title"]}')
        print(f'   Position: {result["position"]}')
        print()
    
    return {
        'search_query': 'red hairstyle',
        'search_box_ref': search_box_ref,
        'results_count': len(results),
        'results': results
    }

# Run main program
if __name__ == '__main__':
    result = asyncio.run(main())
    print('\nTask completed!')
    print(f'Search query: {result["search_query"]}')
    print(f'Search box ref: {result["search_box_ref"]}')
    print(f'Results found: {result["results_count"]}')