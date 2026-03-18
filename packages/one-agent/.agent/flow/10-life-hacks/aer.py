import asyncio

async def main():
    from datetime import datetime
    queries = [
        'practical cooking tips for beginners',
        'travel packing hacks carry on only',
        'simple personal budgeting tricks daily life',
        'communication habits to reduce misunderstandings',
        'home cleaning routines for busy people',
        'meal prep shortcuts for working adults',
        'time management tips for daily life',
        'common sense household tips first apartment',
    ]

    snippets = []
    for q in queries:
        s = await act('websearch', {'query': q})
        if s.get('isError'):
            continue
        txt = s.get('content', [{}])[0].get('text', '')
        if txt:
            snippets.append('Query: ' + q + '\n' + txt[:2600])

    if not snippets:
        return print('Search failed: no usable sources found.')

    prompt = (
        'Create 10 practical life experience tricks/hacks. '
        'Audience: someone who feels they lack common sense in daily situations. '
        'Focus areas: cooking, traveling, money, home, communication, planning. '
        'Each item must be simple and directly actionable. '\
        'For each item return: rank, title, category, why_it_helps, steps, example, avoid_this. '
        'The example must be realistic and easy to understand in 2-4 short sentences. '\
        'Keep language plain and non-judgmental. '
        'Source snippets:\n\n' + '\n\n'.join(snippets)
    )

    r = await reason(
        prompt,
        [
            {
                'rank': 1,
                'title': '',
                'category': '',
                'why_it_helps': '',
                'steps': [''],
                'example': '',
                'avoid_this': '',
            }
        ],
    )
    if r.get('error'):
        return print(r['error'])

    items = r.get('data') or []
    today = datetime.now().strftime('%Y-%m-%d')
    report = '# 10 Practical Life Experience Tricks\n\n'
    report += '**Date**: ' + today + '\n\n'
    report += 'Use this as a practical guide for everyday life.\n\n---\n\n'

    for item in items:
        steps = item.get('steps') or []
        step_lines = ''
        for i, step in enumerate(steps, start=1):
            step_lines += str(i) + '. ' + str(step) + '\n'

        report += '## ' + str(item.get('rank')) + '. ' + str(item.get('title')) + '\n\n'
        report += '**Category**: ' + str(item.get('category')) + '\n\n'
        report += '**Why it helps**: ' + str(item.get('why_it_helps')) + '\n\n'
        report += '**Steps**:\n' + (step_lines if step_lines else '1. (no steps)\n') + '\n'
        report += '**Example you can copy**: ' + str(item.get('example')) + '\n\n'
        report += '**Avoid this**: ' + str(item.get('avoid_this')) + '\n\n---\n\n'

    report += '## Quick Start\n\n'
    report += 'Pick only 2 tricks this week. Practice them until they feel natural, then add more.\n'

    w = await act('write', {'path': 'life_hacks_guide.md', 'content': report})
    if w.get('isError'):
        return print('Write error:', w)

    print('Report generated: life_hacks_guide.md')
    print(report[:2000])


asyncio.run(main())
