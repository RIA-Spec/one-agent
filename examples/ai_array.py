import asyncio

async def main():
    items = ['apple', 'banana', 'carrot', 'broccoli']
    result = await reason(
        'Categorize into fruits and vegetables: ' + str(items),
        {'fruits': ['apple'], 'vegetables': ['carrot']}
    )
    print('Fruits:', result['data']['fruits'])
    print('Vegetables:', result['data']['vegetables'])

asyncio.run(main())
