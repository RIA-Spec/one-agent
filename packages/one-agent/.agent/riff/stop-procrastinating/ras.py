import asyncio

async def main():
    today = __import__('datetime').datetime.now().strftime('%Y-%m-%d')
    r = await reason(
        'Goal: provide one quick psychological intervention for procrastination. '
        'Observation: the user needs one immediate action. '
        'Constraints: pick exactly one battle-tested technique from 2-min rule, temptation bundling, 5-min start, body doubling, or Eat the Frog. '
        'Return technique name, why it works in one sentence, an exact action prompt under 30 words, and a short pep talk.',
        {'technique': '', 'why': '', 'action': '', 'pep_talk': ''}
    )
    if r.get('error'):
        return print(r['error'])
    d = r['data']
    out = f"""
========================================
   ANTI-PROCRASTINATION DAILY DOSE
   {today}
========================================

TODAY'S TECHNIQUE: {d.get('technique')}

Why it works: {d.get('why')}

YOUR ACTION: {d.get('action')}

Pep Talk: {d.get('pep_talk')}
========================================
"""
    print(out)
    log = await act('write', {'path': f'prod_{today}.txt', 'content': out})
    if log.get('isError'):
        print('Log fail:', log)
asyncio.run(main())