# Kokoro browser runtime

This directory contains a browser build derived from
[`uzen-zone/kokoro-js`](https://github.com/uzen-zone/kokoro-js), version 1.2.4,
and WebAssembly runtime files from its `onnxruntime-web` dependency.

The Kokoro runtime is licensed under Apache License 2.0. The full license is in
`LICENSE`.

Local modifications: Leithhome adds one in-memory custom voice slot and a
`setVoiceData()` export so a user-created weighted blend can be synthesized
without reloading the model. This browser build supports Chinese voices only;
Latin words in Chinese dialogue are converted to spoken letter names. Removing
the unused embedded English eSpeak payload keeps the runtime auditable and
prevents an unrelated byte sequence from being mistaken for an API key by
repository secret scanning. Chinese phonemization and model inference otherwise
remain the upstream implementation.

The upstream Transformers model registry entry for Mistral3 is omitted from
this Chinese text-to-speech-only build. Leithhome never loads that unrelated
text-generation model, and its 32-character JavaScript class name is otherwise
misidentified as a Mistral API key by repository secret scanning.
