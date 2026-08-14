name=$(echo "$RIFF_PARAMS" | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
echo "Hello, ${name:-world}!"
