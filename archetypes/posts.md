+++
author = "Bernat Gabor"
date = {{ .Date }}
description = ""
draft = true
image = ""
slug = "{{ .File.ContentBaseName }}"
tags = []
title = "{{ replace .File.ContentBaseName "-" " " | title }}"
+++
