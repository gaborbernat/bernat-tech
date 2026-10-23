{{- /* markdown twin of presentation-list.html: one line per talk instead of thumbnails and play buttons */ -}}
{{- range $i, $talk := sort hugo.Data.presentations "date" "desc" }}
{{ add $i 1 }}. {{ .title }}{{ with .type }} ({{ . }}){{ end }}, {{ .event }}
  {{- with .youtube }}: [video](https://www.youtube.com/watch?v={{ . }}{{ with $talk.start }}&t={{ . }}s{{ end }}){{ end }}
  {{- with .slides }}, [slides]({{ . }}){{ end }}
{{- end }}
