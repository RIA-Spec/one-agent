import asyncio

async def main():
    result = await reason('Summarize in 1 sentence: Python is a programming language.', '')
    print(result['data'])

asyncio.run(main())
