{{- /* markdown twin of presentation-list.html: one line per talk instead of thumbnails and play buttons */ -}}
{{- range hugo.Data.presentations }}
  {{- $talk := . }}
- {{ .title }}{{ with .type }} ({{ . }}){{ end }}, {{ .event }}
  {{- with .youtube }}: [video](https://www.youtube.com/watch?v={{ . }}{{ with $talk.start }}&t={{ . }}s{{ end }}){{ end }}
  {{- with .slides }}, [slides]({{ . }}){{ end }}
{{- end }}
