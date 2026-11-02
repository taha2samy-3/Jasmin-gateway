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
{{- printf "%s-redis-master" .Release.Name }}
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
{{- printf "%s-rabbitmq" .Release.Name }}
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

