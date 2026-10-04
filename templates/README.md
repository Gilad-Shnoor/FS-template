# Service templates

Used by `npm run new:service`. Files are copied into `apps/<name>/` with:

- placeholders replaced: `__name__` (kebab), `__camel__`, `__Pascal__`, `__CONST__`
- conditional blocks kept or dropped based on the service's stack.json settings:

  ```ts
  // @if db          (also: redis, rabbitmq, !db)
  ...lines...
  // @endif
  ```

`contract/` becomes `packages/contracts/src/<name>/index.ts`.
Templates are excluded from lint, typecheck and Docker builds.
