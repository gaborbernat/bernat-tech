# {{ .Title }}
{{ if .Description }}
> {{ .Description }}
{{ end }}{{ if and (eq .Section "posts") (not .Date.IsZero) }}
_Published {{ .Date.Format "January 2, 2006" }}._{{ with .Params.topics }} Topics: {{ delimit . ", " }}.{{ end }}
{{ end }}
{{- /* render shortcodes so readers get the project table, talk list, figures and resolved ref links instead of
     raw {{< >}} calls; the external <script> tags some shortcodes emit mean nothing outside the HTML page */}}
{{ .RenderShortcodes | replaceRE `<script [^>]*src="[^"]*"[^>]*></script>\n?` "" }}
