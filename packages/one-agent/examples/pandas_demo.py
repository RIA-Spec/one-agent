import pandas as pd
import numpy as np

data = {'name': ['Alice', 'Bob', 'Charlie'], 'age': [25, 30, 35], 'score': [85, 90, 95]}
df = pd.DataFrame(data)

print(f"Rows: {len(df)}, Avg age: {df['age'].mean():.1f}, Avg score: {df['score'].mean():.1f}")
