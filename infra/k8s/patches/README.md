# Hand-written patches

Everything in `infra/k8s/generated/` and `infra/k8s/kustomization.yaml` is regenerated from
`stack.json`. To change something stack.json doesn't model (resource limits, extra env from a
ConfigMap, a sidecar…), drop a Kustomize patch here. Any `*.yaml` file in this folder is picked up
automatically on the next render.

Example, `api-resources.yaml` (strategic merge patch; the target is inferred from kind/name):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: fs-template
spec:
  template:
    spec:
      containers:
        - name: api
          resources:
            limits:
              memory: 2Gi
```
