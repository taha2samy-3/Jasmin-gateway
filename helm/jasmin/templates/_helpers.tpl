{{/*
Expand the name of the chart.
*/}}
{{- define "jasmin.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "jasmin.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "jasmin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "jasmin.labels" -}}
helm.sh/chart: {{ include "jasmin.chart" . }}
{{ include "jasmin.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "jasmin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "jasmin.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name
*/}}
{{- define "jasmin.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "jasmin.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolve Redis Host
*/}}
{{- define "jasmin.redisHost" -}}
{{- if .Values.redis.enabled }}
{{- fail "redis.enabled: this chart does not bundle Redis. Set redis.enabled=false and externalRedis.host/port." }}
{{- else }}
{{- .Values.externalRedis.host }}
{{- end }}
{{- end }}

{{/*
Resolve Redis Port
*/}}
{{- define "jasmin.redisPort" -}}
{{- if .Values.redis.enabled }}
{{- default "6379" .Values.redis.port }}
{{- else }}
{{- default "6379" .Values.externalRedis.port }}
{{- end }}
{{- end }}

{{/*
Resolve RabbitMQ Host
*/}}
{{- define "jasmin.rabbitmqHost" -}}
{{- if .Values.rabbitmq.enabled }}
{{- fail "rabbitmq.enabled: this chart does not bundle RabbitMQ. Set rabbitmq.enabled=false and externalRabbitMQ.host/port." }}
{{- else }}
{{- .Values.externalRabbitMQ.host }}
{{- end }}
{{- end }}

{{/*
Resolve RabbitMQ Port
*/}}
{{- define "jasmin.rabbitmqPort" -}}
{{- if .Values.rabbitmq.enabled }}
{{- default "5672" .Values.rabbitmq.port }}
{{- else }}
{{- default "5672" .Values.externalRabbitMQ.port }}
{{- end }}
{{- end }}


{{/*
External URL of the Jasmin Console: dashboard.publicUrl, else derived from the console
Ingress host (https when TLS is configured) or the first console HTTPRoute hostname.
*/}}
{{- define "jasmin.consoleUrl" -}}
{{- if .Values.dashboard.publicUrl -}}
{{- .Values.dashboard.publicUrl -}}
{{- else if and .Values.dashboard.ingress.enabled .Values.dashboard.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.dashboard.ingress.tls) 0)) .Values.dashboard.ingress.host -}}
{{- else if and .Values.dashboard.httpRoute.enabled .Values.dashboard.httpRoute.hostnames -}}
{{- printf "https://%s" (first .Values.dashboard.httpRoute.hostnames) -}}
{{- end -}}
{{- end -}}

{{/*
Environment shared by the Jasmin and console containers:
 - JASMIN_ENV_FILES: shell env files sourced at start (e.g. Vault Agent output), from .Values.envFiles;
 - JASMIN_LOG_TO_STDOUT: Jasmin logs (and connectors created by the console) go to the container log.
*/}}
{{- define "jasmin.commonRuntimeEnv" -}}
{{- with .Values.envFiles }}
- name: JASMIN_ENV_FILES
  value: {{ join ":" . | quote }}
{{- end }}
- name: JASMIN_LOG_TO_STDOUT
  value: {{ ternary "true" "false" .Values.config.logToStdout | quote }}
{{- end -}}

{{/*
"true" when the logs directory gets its own PersistentVolumeClaim.
*/}}
{{- define "jasmin.logsClaim" -}}
{{- if and .Values.persistence.enabled (ne .Values.persistence.logsEnabled false) -}}true{{- end -}}
{{- end -}}

{{/*
volumeClaimTemplates entries (a YAML list, possibly empty).
*/}}
{{- define "jasmin.volumeClaimTemplates" -}}
{{- if and .Values.persistence.enabled (not .Values.persistence.existingClaim) }}
- apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: store
    {{- with .Values.persistence.annotations }}
    annotations:
      {{- toYaml . | nindent 6 }}
    {{- end }}
  spec:
    accessModes:
      - {{ .Values.persistence.accessMode | quote }}
    {{- if .Values.persistence.storageClass }}
    storageClassName: {{ .Values.persistence.storageClass | quote }}
    {{- end }}
    resources:
      requests:
        storage: {{ .Values.persistence.size | quote }}
{{- end }}
{{- if include "jasmin.logsClaim" . }}
- apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: logs
  spec:
    accessModes:
      - {{ .Values.persistence.accessMode | quote }}
    {{- if .Values.persistence.storageClass }}
    storageClassName: {{ .Values.persistence.storageClass | quote }}
    {{- end }}
    resources:
      requests:
        storage: {{ .Values.persistence.logsSize | default "2Gi" | quote }}
{{- end }}
{{- end -}}

{{/*
StatefulSet volumeClaimTemplates are immutable: changing a PVC size, adding/removing the logs
claim or switching to existingClaim makes `helm upgrade` fail with an opaque "Forbidden" error.
When the live StatefulSet can be read (helm install/upgrade; not `helm template` or Argo CD),
stop early with the procedure instead. Set persistence.skipTemplateCheck=true to bypass.
*/}}
{{- define "jasmin.guardVolumeClaimTemplates" -}}
{{- if not .Values.persistence.skipTemplateCheck }}
{{- $live := lookup "apps/v1" "StatefulSet" .Release.Namespace (include "jasmin.fullname" .) }}
{{- if $live }}
{{- $have := list }}
{{- range ($live.spec.volumeClaimTemplates | default list) }}
{{- $have = append $have (printf "%s=%v" .metadata.name .spec.resources.requests.storage) }}
{{- end }}
{{- $want := list }}
{{- range (include "jasmin.volumeClaimTemplates" . | fromYamlArray) }}
{{- $want = append $want (printf "%s=%v" .metadata.name .spec.resources.requests.storage) }}
{{- end }}
{{- if ne (join "," (sortAlpha $have)) (join "," (sortAlpha $want)) }}
{{- fail (printf `

StatefulSet %s: its PVC templates would change (live: [%s], requested: [%s]).
Kubernetes does not allow changing volumeClaimTemplates in place. To apply it:
  1. Grow existing PVCs directly (StorageClass needs allowVolumeExpansion: true):
       kubectl -n %s patch pvc <claim>-%s-0 -p '{"spec":{"resources":{"requests":{"storage":"<size>"}}}}'
  2. Remove the StatefulSet object but keep the pod and its PVCs running:
       kubectl -n %s delete statefulset %s --cascade=orphan
  3. Run the upgrade again (Argo CD: sync). The new StatefulSet adopts the running pod and PVCs.
Set persistence.skipTemplateCheck=true to skip this check.
` (include "jasmin.fullname" .) (join ", " $have) (join ", " $want) .Release.Namespace (include "jasmin.fullname" .) .Release.Namespace (include "jasmin.fullname" .)) }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}
