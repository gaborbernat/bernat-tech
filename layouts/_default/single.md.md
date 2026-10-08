# {{ .Title }}
{{ if .Description }}
> {{ .Description }}
{{ end }}{{ if and (eq .Section "posts") (not .Date.IsZero) }}
_Published {{ .Date.Format "January 2, 2006" }}._{{ with .Params.topics }} Topics: {{ delimit . ", " }}.{{ end }}
{{ end }}
{{- /* render shortcodes so readers get figures and resolved ref links instead of raw {{< >}} calls; shortcodes whose
     HTML only works in a browser (project table, talk embeds, interactive demos) have a .md.md twin under shortcodes/ */}}
{{ .RenderShortcodes }}
