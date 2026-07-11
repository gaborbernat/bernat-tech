# {{ .Title }}
{{ if .Description }}
> {{ .Description }}
{{ end }}{{ if and (eq .Section "posts") (not .Date.IsZero) }}
_Published {{ .Date.Format "January 2, 2006" }}._{{ with .Params.topics }} Topics: {{ delimit . ", " }}.{{ end }}
{{ end }}
{{ .RawContent }}
