import asyncio

async def main():
    result = await reason('Summarize in 1 sentence: Python is a programming language.', '{"summary": "Summary of the input text"}')
    print(result['data'])

asyncio.run(main())
