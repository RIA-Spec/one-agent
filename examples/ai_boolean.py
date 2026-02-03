import asyncio

async def main():
    errors = 15
    threshold = 10
    result = await ai(f'Should alert? errors={errors}, threshold={threshold}. Return true/false.', True)
    if result['data']:
        print('Alert: Too many errors!')
    else:
        print('All good')

asyncio.run(main())
