import asyncio

async def main():
    print("Launching browser and opening Google...")
    await act('playwright_browser_navigate', {'url': 'https://www.google.com'})
    
    await act('playwright_browser_wait_for', {'time': 3})
    
    snapshot = await act('playwright_browser_snapshot', {})
    

    if snapshot is None:
        print("Error: snapshot returned None")
        return
    
    if isinstance(snapshot, dict) and 'content' in snapshot:
        page_content = snapshot['content'][0]['text']
    elif isinstance(snapshot, list):
        page_content = snapshot[0].get('text', str(snapshot))
    else:
        page_content = str(snapshot)
    
    print("Using AI to analyze page structure...")
    result = await reason(
        f'Analyze Google homepage content and extract key information: {page_content[:3000]}',
        {
            'title': 'Page title',
            'search_box': 'Is search box present',
            'features': ['Feature 1', 'Feature 2'],
            'status': 'Page status description'
        }
    )
    
    print("-" * 30)
    print('Google successfully opened!')
    print(f'Page title:  {result["data"]["title"]}')
    print(f'Search box:  {result["data"]["search_box"]}')
    print(f'Features:    {", ".join(result["data"]["features"])}')
    print(f'Status:      {result["data"]["status"]}')
    print("-" * 30)

if __name__ == "__main__":
    asyncio.run(main())