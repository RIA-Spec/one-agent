# 8. Distortion and Recalibration

When an agent fails in an environment, the common cause is often not missing capability but distortion.

Typical distortions include:

- Treating inference as fact
- Treating local success as overall success
- Treating the standard path as the only path
- Treating stale state as current state
- Treating descriptive information as the real environment itself

A stably working agent therefore needs not only the ability to push forward but also the ability to recalibrate.

The key to recalibration is not immediately adding more actions, but returning to more fundamental questions:

- What is the current environment, really?
- What is already settled?
- What is still only inference?
- Which key constraints have been ignored?
- Should we continue the original path, or correct the understanding first?
